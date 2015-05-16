(function() {
  function createAudioContext() {
    var ac = window.AudioContext || window.webkitAudioContext;
    if (!ac) {
      throw new Error('Audio Web API not available');
    }
    return new ac();
  }

  function createAudioScriptNode(context, bufferSize, outputChannels) {
    if (context.createScriptProcessor) {
      return context.createScriptProcessor(bufferSize, 0, outputChannels);
    } else if (context.createJavaScriptNode) {
      return context.createJavaScriptNode(bufferSize, 0, outputChannels);
    } else {
      throw new Error('Audio Web API script node not available');
    }
  }

  /**
   * @param {number} channels number of output channels
   * @return {Float32Array[]}
   */
  function createBuffer(channels) {
    var buffer = new Array(channels);
    for (var channel = 0; channel < channels; channel++) {
      buffer[channel] = [];
    }
    return buffer;
  };

  /**
   * Resample data for one channel.
   * TODO: this is a very basic and naive implementation
   * @param {Float32Array} inputSamples
   * @param {number} inputSampleRate
   * @param {number} outputSampleRate expected sample rate
   * @return {Float32Array}
   */
  function resampleChannelData(inputSamples, inputSampleRate, outputSampleRate) {
    if (inputSampleRate == outputSampleRate) {
      return samples;
    }

    var outputSamplesCount = Math.round(
      inputSamples.length * outputSampleRate / inputSampleRate
    );

    var outputSamples = new Float32Array(outputSamplesCount);
    var rateRatio = inputSampleRate / outputSampleRate;

    for (var outputIndex = 0; outputIndex < outputSamplesCount; ++outputIndex) {
      var inputIndex = outputIndex * rateRatio | 0;
      outputSamples[outputIndex] = inputSamples[inputIndex];
    }

    return outputSamples;
  }

  /**
   * Resample some audio data.
   * TODO: this is a very basic and naive implementation
   * @param {Float32Array[]} data samples arrays by channel
   * @param {number} dataSampleRate sample rate for provided data
   * @param {number} targetSampleRate sample rate result is expected to have
   * @param {number} targetChannels expected number of channels for result
   */
  function resampleData(data, dataSampleRate, targetSampleRate, targetChannels) {
    var dataChannels = data.length;

    if (dataSampleRate == targetSampleRate && dataChannels == targetChannels) {
      return data;
    } else if (!dataChannels) {
      throw new Error('internal error');
    }

    var newData = new Array(targetChannels);
    for (var channel = 0; channel < targetChannels; ++channel) {
      if (channel >= dataChannels) {
        newData[channel] = newData[0];
      } else {
        newData[channel] = resampleChannelData(data[channel], dataSampleRate, targetSampleRate);
      }
    }

    return newData;
  }

  /**
   * A number of audio contexts is limited, and there is no way to dispose them.
   * So, use just one and share it among all audio feeder instances.
   * TODO:
   * On iOS, when audio context is created, and this happens not as a result
   *  of a user action (i.e. inside onclick handler), this context is forever
   *  disfuntional, not consuming samples, and not reporting time updates.
   * As a workaround we delay context creation if feeder is initially muted,
   *  simulating samples consumption until sound is enabled, hopefully as a
   *  result of a tap somewhere.
   * @type {AudioContext}
   */
  var SharedAudioContext = null;

  window.AudioFeeder = function(options) {
    options = options || {};

    var bufferSize = options.bufferSize || 4096;
    var initialized = false;
    // unset until 'init'
    var inputChannels = null;
    var inputSampleRate = null;
    // unset until we create AudioContext
    var outputChannels = null;
    var outputSampleRate = null;

    var muted = false;
    var playing = false;

    /**
     * @type {AudioContext}
     */
    var audioContext = null;

    /**
     * @type {ScriptProcessorNode}
     */
    var audioNode = null;

    /**
     * A storage for waiting-to-play input data, not resampled yet.
     * @type {Float32Array[]} array of samples by channel
     */
    var inputBuffer = null;

    /**
     * Context-based timestamp for samples queue head
     * @type {number}
     */
    var playbackTimeAtBufferHead = 0;

    /**
     * A number of samples currently in inputBuffer
     * @type {number}
     */
    var inputBufferLength = 0;

    /**
     * A number of cycles we had to skip while startving for data
     * @type {number}
     */
    var starvedCycles = 0;

    /**
     * A number of seconds which we lost due to something running too slow,
     *   i.e. audio cycle callbacks triggered too late
     * @type {number}
     */
    var lostDuration = 0;

    this.init = function(channels, sampleRate) {
      if (initialized) {
        throw new Error('AudioFeeder already initialized');
      }
      inputChannels = channels || 2;
      inputSampleRate = sampleRate || 44100;
      inputBuffer = createBuffer(inputChannels);
      inputBufferLength = 0;
      initialized = true;
    };

    this.close = function() {
      this.stop();
      inputChannels = null;
      inputSampleRate = null;
      outputChannels = null;
      outputSampleRate = null;
      inputBuffer = null;
      inputBufferLength = 0;
      starvedCycles = 0;
      lostDuration = 0;
      initialized = false;
    };

    /**
     * Push buffered data to a playback queue
     * @param {OGVCoreAudioBuffer} buffer
     */
    this.bufferData = function(buffer) {
      if (buffer.layout.channelCount != inputChannels) {
        throw new Error('unexpected number of channels received');
      }

      // console.log('buffer: ' + buffer.samples[0].length + ' / ' + inputBuffer[0].length + '(' + playbackTimeAtBufferHead + ' / ' + starvedCycles + ')');

      var samplesCount = 0;

      for (var channel = 0; channel < inputChannels; ++channel) {
        var fromChannel = buffer.samples[channel],
            toChannel = inputBuffer[channel],
            length = fromChannel.length;

        for (var sample = 0; sample < length; ++sample) {
          toChannel.push(fromChannel[sample]);
        }

        if (channel == 0) {
          samplesCount = length;
        } else if (samplesCount != length) {
          throw new Error('received channels data with unequal length');
        }
      }

      inputBufferLength += samplesCount;
    };

    /**
		 * @return {
		 *   playbackPosition: {number} context-based playback timestamp in seconds
		 *   bufferedDuration: {number} buffered data size in seconds
		 *   starvedCycles: {number} a number of input buffers we had to wait while starving
		 * }
		 */
    this.getPlaybackState = function() {
      var playbackPosition = 0,
          bufferedDuration = 0;

      if (!!audioContext) {
        playbackPosition = audioContext.currentTime -
          (starvedCycles * bufferSize / (outputSampleRate || 44100)) -
          lostDuration;
      }

      if (!!inputBuffer) {
        bufferedDuration = inputBufferLength / (inputSampleRate || 44100);
      }

      if (playing && !!audioContext && !!inputBuffer) {
        var durationBeforeNextCycle = Math.max(0,
          playbackTimeAtBufferHead - audioContext.currentTime);

        bufferedDuration += durationBeforeNextCycle;
      }

      return {
        playbackPosition: playbackPosition,
        bufferedDuration: bufferedDuration,
        starvedCycles: starvedCycles
      };
    };

    this.start = function() {
      if (!playing) {
        if (!audioContext) {
          if (!!SharedAudioContext) {
            audioContext = SharedAudioContext;
          } else {
            audioContext = SharedAudioContext = createAudioContext();
          }
          outputSampleRate = audioContext.sampleRate;
        }

        if (!audioNode) {
          audioNode = createAudioScriptNode(audioContext, bufferSize, 2);
          outputChannels = 2;
        }

        var self = this;
        audioNode.onaudioprocess = function(event) {
          audioCycleHandler(event, self);
        };
        audioNode.connect(audioContext.destination);
        playbackTimeAtBufferHead = audioContext.currentTime;
        playing = true;
      }
    };

    this.stop = function() {
      if (playing) {
        if (audioNode) {
          audioNode.onaudioprocess = null;
          audioNode.disconnect();
        }
        playing = false;
      }
    };

    this.waitUntilReady = function(callback) {
      setTimeout(callback, 0);
    };

    Object.defineProperty(this, 'bufferSize', {
      get: function() {
        return bufferSize;
      }
    });

    Object.defineProperty(this, 'inputChannels', {
      get: function() {
        return inputChannels;
      }
    });

    Object.defineProperty(this, 'inputSampleRate', {
      get: function() {
        return inputSampleRate;
      }
    });

    Object.defineProperty(this, 'cycleDuration', {
      get: function() {
        var rate = outputSampleRate || 44100;
        return (bufferSize / rate);
      }
    });

    Object.defineProperty(this, 'muted', {
      get: function() {
        return muted;
      },
      set: function(newMuted) {
        if (muted != newMuted) {
          // TODO: if audiocontext was not yet created, do it
          muted = newMuted;
        }
      }
    });

    /**
     * ScriptProcessorNode cycle handler
     * @param {AudioProcessingEvent} event
     */
    function audioCycleHandler(event, feeder) {
      /**
       * Checks event timestamp against feeder clock
       */
      function syncClock() {
        var currentPlaybackTime;

        if (typeof event.playbackTime === 'number') {
          currentPlaybackTime = event.playbackTime;

        } else if (typeof event.timeStamp === 'number') {
          currentPlaybackTime = (event.timeStamp - Date.now()) / 1000 + audioContext.currentTime;

        } else {
          console.error('Unrecognized AudioProgressEvent format, no playbackTime or timeStamp');
          currentPlaybackTime = audioContext.currentTime;
        }

        var expectedPlaybackTime =
          playbackTimeAtBufferHead + (bufferSize / outputSampleRate);
        if (expectedPlaybackTime < currentPlaybackTime) {
          lostDuration += (currentPlaybackTime - expectedPlaybackTime);
        }

        playbackTimeAtBufferHead = currentPlaybackTime;
      }

      function inputSamplesCountForOutputBufferSize() {
        return Math.round(bufferSize / outputSampleRate * inputSampleRate);
      }

      function hasEnoughData() {
        return inputBufferLength >= inputSamplesCountForOutputBufferSize();
      }

      /**
       * Same as consumeDataChunk but when we know there is enough data
       * @return {Float32Array[]} input data to fill output buffer for one cycle
       */
      function doConsumeDataChunk() {
        var length = inputSamplesCountForOutputBufferSize();

        var data = new Array(inputChannels);
        for (var channel = 0; channel < inputChannels; ++channel) {
          // TODO: if performance testing will show AudioFeeder optimization is needed, jsperf input queue
          data[channel] = inputBuffer[channel].splice(0, length);
        }

        inputBufferLength -= length;

        return data;
      }

      /**
       * Take some input data and cook it for audio input
       * @return {Float32Array[]|null} data to fill output buffer if have enough
       */
      function consumeDataChunk() {
        var data = null;

        if (hasEnoughData()) {
          data = doConsumeDataChunk();

        } else {
          if (feeder.onstarved) {
            feeder.onstarved();

            if (hasEnoughData()) {
              data = doConsumeDataChunk();
            }
          }
        }

        return data;
      }

      /**
       * Write "no sound" to output
       * @param {AudioBuffer} outputBuffer
       */
      function zeroOutput(outputBuffer) {
        for (var channel = 0; channel < outputChannels; ++channel) {
          var data = outputBuffer.getChannelData(channel);
          for (var sample = 0; sample < bufferSize; ++sample) {
            data[sample] = 0;
          }
        }
      }

      /**
       * Write samples to output buffer
       * @param {Float32Array[]} data
       * @param {AudioBuffer} outputBuffer
       */
      function feedDataToOutput(data, outputBuffer) {
        for (var channel = 0; channel < outputChannels; ++channel) {
          var dataIn = data[channel];
          var dataOut = outputBuffer.getChannelData(channel);

          if (dataIn.length != bufferSize) {
            while (dataIn.length < bufferSize) {
              dataIn.push(0);
            }
          }

          for (var sample = 0; sample < bufferSize; ++sample) {
            dataOut[sample] = dataIn[sample];
          }
        }
      }

      syncClock();

      var data = consumeDataChunk();

      if (!!data) {
        if (muted) {
          zeroOutput(event.outputBuffer);
        } else {
          feedDataToOutput(data, event.outputBuffer);
        }
        playbackTimeAtBufferHead += (bufferSize / outputSampleRate);

      } else {
        zeroOutput(event.outputBuffer);
        ++starvedCycles;
      }
    }
  };

  /**
   * @return {boolean} true if AudioContext and friends is available
   */
  window.AudioFeeder.webAudioApiAvailable = function() {
    return !!(window.AudioContext || window.webkitAudioContext);
  }
})();
