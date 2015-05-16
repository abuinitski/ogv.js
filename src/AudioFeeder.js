(function() {
  /* TODO:
  * On iOS, when audio context is created, and this happens not as a result
  *  of a user action (i.e. inside onclick handler), this context is forever
  *  disfuntional, not consuming samples, and not reporting time updates.
  * As a workaround we delay context creation if feeder is initially muted,
  *  simulating samples consumption until sound is enabled, hopefully as a
  *  result of a tap somewhere.
  */


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

  window.AudioFeeder = function() {
    var initialized = false;
    // unset until 'init'
    var inputChannels = null;
    var inputSampleRate = null;

    var muted = false;

    /**
     * A storage for waiting-to-play input data, not resampled yet.
     * @type {Float32Array[]} array of samples by channel
     */
    var inputBuffer = null;

    /**
     * A number of samples currently in inputBuffer
     * @type {number}
     */
    var inputBufferLength = 0;

    /**
     * Underlying engine implementation for actually playing the sound.
     * Playback should start as soon as it's created, and stop after 'close'.
     * @type {AudioFeeder.Web|AudioFeeder.Dummy|null}
     */
    var engine = null;

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
      inputBuffer = null;
      inputBufferLength = 0;
      initialized = false;
    };

    /**
     * Push data to an internal playback buffer
     * @param {OGVCoreAudioBuffer} buffer
     */
    this.bufferData = function(buffer) {
      if (buffer.layout.channelCount != inputChannels) {
        throw new Error('unexpected number of channels received');
      }

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
      var state;
      if (engine) {
        state = engine.getPlaybackState();

      } else {
        state = {
          playbackPosition: 0,
          bufferedDuration: 0,
          starvedCycles: 0
        };
      }

      if (!!inputBuffer) {
        state.bufferedDuration += inputBufferLength / (inputSampleRate || 44100);
      }

      return state;
    };

    this.start = function() {
      if (!initialized) {
        throw new Error('AudioFeeder should be initialized before start')
      }

      if (!engine) {
        if (AudioFeeder.Web.isAvailable()) {
          engine = new AudioFeeder.Web(inputChannels, inputSampleRate, onEngineDataRequest);
        } else {
          engine = new AudioFeeder.Dummy(inputChannels, inputSampleRate, onEngineDataRequest);
        }
      }

      engine.start();
    };

    this.stop = function() {
      if (!!engine) {
        engine.stop();
      }
    };

    this.waitUntilReady = function(callback) {
      if (engine) {
        engine.waitUntilReady(callback);
      } else {
        setTimeout(callback, 0);
      }
    };

    Object.defineProperty(this, 'preferredBufferDuration', {
      get: function() {
        if (engine) {
          return engine.preferredBufferDuration;
        } else {
          // something around twice the cycle duration for 4096-samples chunk and 44100 sample rate
          return 0.02;
        }
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
     * Callback for engines when they need some data to play
     */
    var onEngineDataRequest = (function(self) {
      return function(samplesCount) {

        function hasEnoughData() {
          return inputBufferLength >= samplesCount;
        }

        function consumeData() {
          var data = new Array(inputChannels);
          for (var channel = 0; channel < inputChannels; ++channel) {
            data[channel] = inputBuffer[channel].splice(0, samplesCount);
          }
          inputBufferLength -= samplesCount;
          return data;
        }

        var data = null;

        if (hasEnoughData()) {
          data = consumeData();
        } else {
          if (self.onstarved) {
            self.onstarved();

            if (hasEnoughData()) {
              data = consumeData();
            }
          }
        }

        return data;
      };
    })(this);
  };
})();
