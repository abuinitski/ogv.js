(function() {

  /**
   * A number of audio contexts is limited, and there is no way to dispose them.
   * So, use just one and share it among all audio feeder instances.
   * @type {AudioContext}
   */
  var SharedAudioContext = null;

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
      return [];
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
   * AudioFeeder engine which uses Web Audio API
   * @param {function} dataCallback a callback to request data from
   * @param {number} inputchannels
   * @param {number} inputSampleRate
   * @constructor
   */
  window.AudioFeeder.Web = function(inputChannels, inputSampleRate, dataRequestCallback) {
    /**
     * @type {AudioContext}
     */
    var audioContext = null;

    /**
     * @type {ScriptProcessorNode}
     */
    var audioNode = null;

    /**
     * Context-based timestamp for samples in queue head
     * @type {number}
     */
    var playbackTimeAtBufferHead = 0;

    /**
     * Size of the buffer on which processor node operates
     * @type {number}
     */
    var bufferSize = 4096;

    /**
     * Number of output channels
     * @type {number}
     */
    var outputChannels = null;

    /**
     * Output Sample Rate
     * @type {number}
     */
    var outputSampleRate = null;

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

    /**
     * @type {boolean}
     */
    var started = false;

    /**
     * @type {boolean}
     */
    var muted = false;

    /**
     * Main constructor body
     */
    function init() {
      var self = this;

      audioContext = SharedAudioContext;
      if (!audioContext) {
        audioContext = SharedAudioContext = createAudioContext();
      }
      outputSampleRate = audioContext.sampleRate;

      outputChannels = 2;
      audioNode = createAudioScriptNode(audioContext, bufferSize, outputChannels);
    }

    /**
     * ScriptProcessorNode cycle body
     * @param {AudioProcessingEvent} event
     */
    function audioCycleHandler(event) {
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

      var data = dataRequestCallback(inputSamplesCountForOutputBufferSize());

      console.log('omnom?');
      if (!!data) {
        console.log('nom!');
        data = resampleData(data, inputSampleRate, outputSampleRate, outputChannels);
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

    /**
     * Start or resume audio playback
     */
    this.start = function() {
      if (!started) {
        audioNode.onaudioprocess = audioCycleHandler;
        audioNode.connect(audioContext.destination);

        playbackTimeAtBufferHead = audioContext.currentTime;

        started = true;
      }
    };

    /*
     * Pause audio playback
     */
    this.stop = function() {
      if (started) {
        audioNode.onaudioprocess = null;
        audioNode.disconnect();
        started = false;
      }
    };

    /*
     * @see AudioFeeder.waitUntilReady
     */
    this.waitUntilReady = function(callback) {
      setTimeout(callback, 0);
    };

    /**
     * @see AudioFeeder.getPlaybackState
     */
    this.getPlaybackState = function() {
      var playbackPosition = 0,
          bufferedDuration = 0;

      playbackPosition = audioContext.currentTime -
        (starvedCycles * bufferSize / (outputSampleRate || 44100)) -
        lostDuration;

      var durationBeforeNextCycle = Math.max(0,
        playbackTimeAtBufferHead - audioContext.currentTime);
      bufferedDuration = durationBeforeNextCycle;

      return {
        playbackPosition: playbackPosition,
        bufferedDuration: bufferedDuration,
        starvedCycles: starvedCycles
      };
    };

    Object.defineProperty(this, 'muted', {
      get: function() {
        return muted;
      },
      set: function(isMuted) {
        muted = isMuted;
      }
    });

    Object.defineProperty(this, 'outputSampleRate', {
      get: function() {
        return outputSampleRate;
      }
    });

    Object.defineProperty(this, 'preferredBufferDuration', {
      get: function() {
        return 2 * (bufferSize / outputSampleRate);
      }
    });

    init();
  };

  /**
   * @return {boolean} true if AudioContext and friends is available
   */
  window.AudioFeeder.Web.isAvailable = function() {
    return !!(window.AudioContext || window.webkitAudioContext);
  };
})();
