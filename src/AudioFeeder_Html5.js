(function() {

    var timestamp = (function() {
        var method = Date.now;

        if (window.performance !== undefined && window.performance.now !== undefined) {
            method = window.performance.now.bind(window.performance);
        }

        return function() {
            return method() / 1000;
        };
    })();

    /**
     * An abstraction to manage audio time calculation
     * @constructor
     */
    function AudioTime() {
        var SYNC_AUDIO_THRESHOLD = 0.2;
        var SYNC_CLOCK_THRESHOLD = 0.4;

        var anchorAudioTime = 0;
        var anchorClockTime = timestamp();

        var active = false;
        var stalled = false;
        var emulated = false;

        function fixAudioTime(time, now) {
            if (now === undefined) {
                now = timestamp();
            }
            if (time === undefined) {
                time = computeAudioTime(now);
            }
            anchorAudioTime = time;
            anchorClockTime = now;
        }

        function computeAudioTime(now) {
            var time = anchorAudioTime;

            if (active && !stalled) {
                var elapsedSinceLastUpdate = (now - anchorClockTime);

                if (emulated || elapsedSinceLastUpdate < SYNC_CLOCK_THRESHOLD) {
                    time += elapsedSinceLastUpdate;
                } else {
                    time += SYNC_CLOCK_THRESHOLD;
                    fixAudioTime(time, now);
                    stalled = true;
                }
            }

            return time;
        }

        this.get = function() {
            return computeAudioTime(timestamp());
        };

        this.sync = function(reportedTime) {
            var now = timestamp();
            var computedTime = computeAudioTime(now);
            var threshold = computedTime - reportedTime;

            if (Math.abs(threshold) > SYNC_AUDIO_THRESHOLD) {
                fixAudioTime(reportedTime, now);
            } else {
                fixAudioTime(computedTime, now);
            }

            stalled = false;
        };

        Object.defineProperty(this, 'active', {
            get: function() {
                return active;
            },
            set: function(value) {
                value = !!value;
                if (value !== active) {
                    fixAudioTime();
                    active = value;
                }
            }
        });

        Object.defineProperty(this, 'stalled', {
            get: function() {
                return stalled;
            },
            set: function(value) {
                value = !!value;
                if (value !== stalled) {
                    fixAudioTime();
                    stalled = value;
                }
            }
        });

        Object.defineProperty(this, 'emulated', {
            get: function() {
                return emulated;
            },
            set: function(value) {
                value = !!value;
                if (value !== emulated) {
                    fixAudioTime();
                    emulated = value;
                }
            }
        });
    }

    /**
     * Fallback audio feeder which will ignore ogv audio stream and play audio via html5 audio tag
     * from a separate URL.
     * @constructor
     */
    window.AudioFeeder.Html5 = function(audioTrackSrc, dataRequestCallback) {
        var started = false;
        var muted = false;

        var audioTime = new AudioTime();

        var audio = (function() {
            var audio = document.createElement('audio');
            audio.src = audioTrackSrc;
            audio.addEventListener('timeupdate', function() {
                audioTime.sync(audio.currentTime);
            });
            audio.addEventListener('ended', function() {
                started = false;
            });
            audio.addEventListener('stalled', function() {
                audioTime.stalled = true;
            });
            audio.addEventListener('waiting', function() {
                audioTime.stalled = true;
            });
            return audio;
        })();
        var audioOn = false;

        var audioDataConsumeTimestamp = 0;

        function updateAudioState() {
            var audioShouldOn = (started && !muted);

            if (audioOn != audioShouldOn) {
                audioOn = audioShouldOn;
                if (audioOn) {
                    audioTime.stalled = true;
                    audio.currentTime = audioTime.get();
                    audio.play();
                } else {
                    audioTime.stalled = false;
                    audio.pause();
                }
            }

            audioTime.active = started;
            audioTime.emulated = muted;
        }

        function consumeAudioData() {
            var data;
            do {
                data = dataRequestCallback(128);
            } while(data);
            audioDataConsumeTimestamp = timestamp();
        }

        function maybeConsumeAudioData() {
            if (timestamp() - audioDataConsumeTimestamp > 0.02) {
                setTimeout(consumeAudioData, 0);
            }
        }

        this.start = function() {
            if (!started) {
                started = true;
                updateAudioState();
            }
        };

        this.stop = function() {
            if (started) {
                started = false;
                updateAudioState();
            }
        };

        this.waitUntilReady = function(callback) {
            setTimeout(callback, 0);
        };

        this.getPlaybackState = function() {
            maybeConsumeAudioData();
            return {
                playbackPosition: audioTime.get(),
                bufferedDuration: 0.04,
                starvedCycles: 0
            };
        };

        Object.defineProperty(this, 'muted', {
            get: function() {
                return muted;
            },
            set: function(value) {
                value = !!value;
                if (muted !== value) {
                    muted = value;
                    updateAudioState();
                }
            }
        });

        Object.defineProperty(this, 'dead', {
            value: false,
            writable: false
        });

        Object.defineProperty(this, 'preferredBufferDuration', {
            value: 0.02,
            writable: false
        });

        Object.defineProperty(this, 'started', {
            get: function() {
                return started;
            }
        });
    };
})();
