(function() {
  var AC_INITIALIZATION_TIMEOUT = 600;
  var AC_INITIALIZATION_INTERVAL = 50;
  var AC_WATCHDOG_INTERVAL = 250;

  /**
   * A number of audio contexts is limited, and there is no way to dispose them.
   * So, use just one and share it among all audio feeder instances.
   * @type {AudioContext}
   */
  var CurrentAudioContext = null;

  /**
   * When audio context is initializing,
   * this array is not null, and new requests are stacked there,
   * so only one initialization is active at the same time.
   * @type {Array}
   */
  var AudioContextRequests = null;

  /**
   * On iOS, AudioContext can be killed by user enabling background music.
   * So, keep a watchdog to monitor those cases.
   *
   * To gracefully handle dead audio contexts, make sure player is paused
   * during this unfortunate event (AudioFeeder will then detect it's dead
   * and re-create Web engine).
   *
   * Even better, make sure player is also muted, that way AudioFeeder will
   * restart with Dummy engine, and at least not stop the video if Web engine
   * fails to initialize.
   */
  function startAudioContextWatchdog() {
    var lastContextTime = null;

    setInterval(function() {
      if (CurrentAudioContext) {
        var currentContextTime = CurrentAudioContext.currentTime;

        if (lastContextTime == null) {
          // init
          lastContextTime = currentContextTime;

        } else if (currentContextTime !== lastContextTime) {
          // alive
          lastContextTime = currentContextTime;

        } else {
          // dead
          CurrentAudioContext = null;
          lastContextTime = null;
        }
      }
    }, AC_WATCHDOG_INTERVAL);
  }
  startAudioContextWatchdog();

  /**
   * Make sure AudioContext is properly prepared before it can
   * really be functional.
   * @param {function()} callback
   */
  function obtainSharedAudioContext(callback) {
    if (CurrentAudioContext) {
      callback();
      return;

    } else if (AudioContextRequests !== null) {
      AudioContextRequests.push(callback);
      return;
    }

    AudioContextRequests = [callback];

    var acConstructor = window.AudioContext || window.webkitAudioContext;
    if (!acConstructor) {
      throw new Error('Audio Web API not available');
    }

    var ac = new acConstructor();

    // need some API call to get things moving inside AudioContext
    ac.createGainNode();

    // now poll periodically to catch initialization completion;
    var timePassed = 0;

    function complete() {
      CurrentAudioContext = ac;
      var callbacks = AudioContextRequests;
      AudioContextRequests = null;

      for (var i = 0; i < callbacks.length; ++i) {
        callbacks[i]();
      }
    }

    function pollCompletion() {
      if (ac.currentTime === 0) {
        timePassed += AC_INITIALIZATION_INTERVAL;

        if (timePassed > AC_INITIALIZATION_TIMEOUT) {
          console.log('failed to initialize Web Audio context');
          AudioContextRequests = null;

        } else {
          setTimeout(pollCompletion, AC_INITIALIZATION_INTERVAL);
        }

      } else {
        complete();
      }
    }

    pollCompletion();
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
   * @param {function} dataRequestCallback a callback to request data from
   * @param {number} inputChannels
   * @param {number} inputSampleRate
   * @constructor
   */
  window.AudioFeeder.Web = function(inputChannels, inputSampleRate, dataRequestCallback) {
    /**
     * @type {ScriptProcessorNode|JavaScriptNode}
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
     * A number of seconds at which AudioContext starts when assigned to this
     * feeder engine. Needed to fix cases when AudioContext was initializing longer
     * and feeder reported a few zero timestamps to the player.
     * @type {number}
     */
    var audioContextTimeCorrection = 0;

    /**
     * Main constructor body
     */
    function init() {
      obtainSharedAudioContext(completeInitialization);
    }

    function completeInitialization() {
      if (CurrentAudioContext) {
        outputSampleRate = CurrentAudioContext.sampleRate;
        outputChannels = 2;
        audioNode = createAudioScriptNode(CurrentAudioContext, bufferSize, outputChannels);

        if (started) {
          doStart();
        }
      }
    }

    /**
     * AudioContext.currentTime with necessary corrections for
     * time wasted during initialization.
     * @param {number} [timestamp]
     */
    function getContextTime(timestamp) {
      if (CurrentAudioContext) {
        if (timestamp === undefined) {
          return CurrentAudioContext.currentTime - audioContextTimeCorrection;
        } else {
          return timestamp - audioContextTimeCorrection;
        }
      } else {
        return 0;
      }
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
        var eventPlaybackTime;

        if (typeof event.playbackTime === 'number') {
          eventPlaybackTime = getContextTime(event.playbackTime);

        } else if (typeof event.timeStamp === 'number') {
          eventPlaybackTime = (event.timeStamp - Date.now()) / 1000 + getContextTime();

        } else {
          console.log(new Error('Unrecognized AudioProgressEvent format, no playbackTime or timeStamp'));
          eventPlaybackTime = getContextTime();
        }

        var expectedPlaybackTime =
          playbackTimeAtBufferHead + (bufferSize / outputSampleRate);
        if (expectedPlaybackTime < eventPlaybackTime) {
          lostDuration += (eventPlaybackTime - expectedPlaybackTime);
        }

        playbackTimeAtBufferHead = eventPlaybackTime;
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

      if (!!data) {
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

    function doStart() {
      if (started && audioNode && CurrentAudioContext) {
        audioContextTimeCorrection = CurrentAudioContext.currentTime;
        audioNode.onaudioprocess = audioCycleHandler;
        audioNode.connect(CurrentAudioContext.destination);
        playbackTimeAtBufferHead = getContextTime();
      }
    }

    /**
     * Start or resume audio playback
     */
    this.start = function() {
      if (!started) {
        started = true;
        doStart();
      }
    };

    /**
     * Pause audio playback
     */
    this.stop = function() {
      if (started) {
        if (audioNode) {
          audioNode.onaudioprocess = null;
          audioNode.disconnect();
        }
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
      var playbackPosition,
          bufferedDuration;

      var contextTime = getContextTime();

      playbackPosition = contextTime -
        (starvedCycles * bufferSize / (outputSampleRate || 44100)) -
        lostDuration;

      bufferedDuration = Math.max(
          0, playbackTimeAtBufferHead - contextTime
      );

      return {
        playbackPosition: playbackPosition,
        bufferedDuration: bufferedDuration,
        starvedCycles: starvedCycles
      };
    };

    Object.defineProperty(this, 'dead', {
      get: function() {
        return !CurrentAudioContext;
      }
    });

    Object.defineProperty(this, 'muted', {
      get: function() {
        return muted;
      },
      set: function(isMuted) {
        muted = isMuted;
      }
    });

    Object.defineProperty(this, 'preferredBufferDuration', {
      get: function() {
        return 2 * (bufferSize / outputSampleRate);
      }
    });

    Object.defineProperty(this, 'started', {
      get: function() {
        return started;
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

  /**
   * Wait for web api to be properly prepared before
   * it can be functional.
   * @param {function()} callback
   */
  window.AudioFeeder.Web.prepare = function(callback) {
    obtainSharedAudioContext(callback);
  };
})();
