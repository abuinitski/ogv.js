(function() {

  var timestamp = (function() {
    if (window.performance === undefined || window.performance.now === undefined) {
  		return Date.now;
  	} else {
      return function() {
        return window.performance.now() / 1000;
      };
  	}
  })();

  /**
   * Dummy audio feeder engine which will only pretend playing sound but will consume data in small chunks
   * @constructor
   */
  window.AudioFeeder.Dummy = function(inputChannels, inputSampleRate, dataRequestCallback) {
    var cycleDuration = 10;

    var playTimer = null;
    var playStartTimestamp = 0;
    var lastPlayCycleTimestamp = 0;
    var samplesConsumed = 0;

    var starvedCycles = 0;
    var starvedDuration = 0;

    function playCycle() {
      var now = timestamp();
      var playDuration = (now - playStartTimestamp) - starvedDuration;

      var samplesHadToConsume = playDuration * inputSampleRate;

      if (samplesHadToConsume - samplesConsumed > 10) {
        var toConsume = samplesHadToConsume - samplesConsumed;

        var hadEnoughData = !!dataRequestCallback(toConsume);
        if (hadEnoughData) {
          samplesConsumed += toConsume;
        } else {
          ++starvedCycles;
          starvedDuration += (now - lastPlayCycleTimestamp);
        }
      }

      lastPlayCycleTimestamp = now;
    }

    this.start = function() {
      if (!playTimer) {
        playStartTimestamp = lastPlayCycleTimestamp = timestamp();
        starvedDuration = 0;
        samplesConsumed = 0;
        playTimer = setInterval(playCycle, cycleDuration);
      }
    };

    this.stop = function() {
      if (playTimer) {
        clearInterval(playTimer);
        playTimer = null;
      }
    };

    this.waitUntilReady = function(callback) {
      setTimeout(callback, 0);
    };

    this.getPlaybackState = function() {
      return {
        playbackPosition: timestamp() - starvedDuration,
        bufferedDuration: 0,
        starvedCycles: starvedCycles
      };
    };

    this.muted = false;

    Object.defineProperty(this, 'preferredBufferDuration', {
      value: 0.02,
      writable: false
    });

    Object.defineProperty(this, 'started', {
      get: function() {
        return !!playTimer;
      }
    });
  };
})();
