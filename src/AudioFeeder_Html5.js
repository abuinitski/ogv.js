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

    var sharedAudio = null;
    var sharedAudioListeners = {};

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
            if (active) {
                var now = timestamp();
                var computedTime = computeAudioTime(now);
                var threshold = computedTime - reportedTime;

                if (Math.abs(threshold) > SYNC_AUDIO_THRESHOLD) {
                    fixAudioTime(reportedTime, now);
                } else {
                    fixAudioTime(computedTime, now);
                }

                stalled = false;
            }
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
    window.AudioFeeder.Html5 = function(audioTrackSrc, audioTitle, dataRequestCallback) {
        var started = false;
        var muted = false;
        var suspended = false;

        var audioTime = new AudioTime();

        var audio = null;
        var audioOn = false;
        var audioPrepared = false;

        var heartbeat = (function(me) {
            return function() {
                if (me.onheartbeat) {
                    me.onheartbeat();
                }
            }
        })(this);

        function createAudio() {
            if (!sharedAudio) {
                sharedAudio = document.createElement('audio');

            } else {
                if (sharedAudio.src !== audioTrackSrc) {
                    sharedAudio.src = '';
                    sharedAudio.load();
                }

                sharedAudio.removeEventListener('timeupdate', sharedAudioListeners.timeupdate);
                sharedAudio.removeEventListener('ended', sharedAudioListeners.ended);
                sharedAudio.removeEventListener('stalled', sharedAudioListeners.stalled);
                sharedAudio.removeEventListener('waiting', sharedAudioListeners.waiting);
            }

            var audio = sharedAudio;
            if (sharedAudio.src !== audioTrackSrc) {
                audio.src = audioTrackSrc;
            }

            audio.setAttribute('title', audioTitle);

            sharedAudioListeners = {
                timeupdate: function() {
                    audioTime.sync(audio.currentTime);
                    heartbeat();
                },
                ended: function() {
                    started = false;
                    updateAudioState();
                    heartbeat();
                },
                stalled: function() {
                    if (audioOn) {
                        audio.pause();
                        audioOn = false;
                        updateAudioState();
                    }
                    heartbeat();
                },
                waiting: function() {
                    audioTime.stalled = true;
                    heartbeat();
                }
            };
            audio.addEventListener('timeupdate', sharedAudioListeners.timeupdate);
            audio.addEventListener('ended', sharedAudioListeners.ended);
            audio.addEventListener('stalled', sharedAudioListeners.stalled);
            audio.addEventListener('waiting', sharedAudioListeners.waiting);

            return audio;
        }

        var audioDataConsumeTimestamp = 0;

        function updateAudioState() {
            var audioShouldOn = (started && !suspended && !muted);

            if (audioOn != audioShouldOn) {
                audioOn = audioShouldOn;

                if (audioOn) {
                    audioTime.stalled = true;

                    if (audio === null) {
                        audio = createAudio();
                    }

                    var seekTime = audioTime.get();
                    if (seekTime > 0) {
                        if (audioPrepared) {
                            audio.currentTime = seekTime;

                        } else {
                            audio.addEventListener('durationchange', function(e) {
                                if (audio.duration > 1) {
                                    e.target.removeEventListener(e.type, arguments.callee);
                                    audioPrepared = true;
                                    audio.currentTime = seekTime;
                                }
                            });
                        }
                    }

                    audio.play();

                } else {
                    audioTime.stalled = false;
                    if (!audio.ended) {
                        audio.pause();
                    }
                }
            }

            audioTime.active = started && !suspended;
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

        this.onheartbeat = null;

        this.start = function() {
            if (!started) {
                started = true;
                suspended = false;
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

        this.resetDataRequestCallback = function(callback) {
            dataRequestCallback = callback;
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

        Object.defineProperty(this, 'suspended', {
            get: function() {
                return suspended;
            },
            set: function(value) {
                value = !!value;
                if (suspended !== value) {
                    suspended = value;
                    updateAudioState();
                }
            }
        });

        Object.defineProperty(this, 'src', {
            get: function() {
                return audioTrackSrc;
            }
        });
    };
})();
