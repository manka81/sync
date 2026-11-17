(function () {
    'use strict';

    var FIREBASE_URL = 'https://synx-332c2-default-rtdb.europe-west1.firebasedatabase.app';

    if (window.tv_phone_sync_plugin_loaded) return;
    window.tv_phone_sync_plugin_loaded = true;

    var hashToKey = {};
    var keyToHash = {};
    var cachedProgress = {};

    var currentContentKey = null;
    var currentHash = null;
    var currentMovieTitle = '';
    var currentSeason = null;
    var currentEpisode = null;
    var syncTimer = null;
    var lastSentTimestamp = 0;
    var MIN_SEND_INTERVAL = 10000;

    function isSyncEnabled() {
        return Lampa.Storage.get('tv_phone_sync_enabled', true);
    }

    function getSyncCode() {
        var code = Lampa.Storage.get('tv_phone_sync_code', '');
        return (code || '').toString().trim().replace(/[^a-zA-Z0-9_\-]/g, '');
    }

    function cleanUrl(url) {
        if (!url) return '';
        return url.replace(/\/+$/, '');
    }

    function formatTime(seconds) {
        var s = Math.floor(seconds || 0);
        var m = Math.floor(s / 60);
        var sec = s % 60;
        var h = Math.floor(m / 60);
        m = m % 60;
        if (h > 0) {
            return h + ':' + (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
        }
        return m + ':' + (sec < 10 ? '0' : '') + sec;
    }

    function ajaxRequest(method, url, data, callback) {
        try {
            var xhr = new XMLHttpRequest();
            xhr.open(method, url, true);
            xhr.timeout = 7000;
            xhr.setRequestHeader('Content-Type', 'application/json; charset=utf-8');

            xhr.onreadystatechange = function () {
                if (xhr.readyState === 4) {
                    if (xhr.status >= 200 && xhr.status < 300) {
                        var parsed = null;
                        try {
                            parsed = JSON.parse(xhr.responseText);
                        } catch (e) {
                            parsed = xhr.responseText;
                        }
                        if (callback) callback(null, parsed);
                    } else {
                        if (callback) callback(new Error('HTTP ' + xhr.status));
                    }
                }
            };

            xhr.ontimeout = function () {
                if (callback) callback(new Error('timeout'));
            };

            xhr.onerror = function () {
                if (callback) callback(new Error('network error'));
            };

            xhr.send(data ? JSON.stringify(data) : null);
        } catch (e) {
            if (callback) callback(e);
        }
    }

    function getFirebaseEndpoint(syncCode, contentKey) {
        var base = cleanUrl(FIREBASE_URL);
        return base + '/users/' + encodeURIComponent(syncCode) + '/' + encodeURIComponent(contentKey) + '.json';
    }

    function getContentKey(movie, season, episode, hash) {
        var id = movie && (movie.id || movie.kp_id || movie.imdb_id);
        if (!id && movie) {
            var title = movie.title || movie.name || movie.original_title || '';
            if (title) id = title.toLowerCase().replace(/[^a-zа-я0-9]/gi, '_');
        }

        var s = parseInt(season, 10);
        var e = parseInt(episode, 10);
        var isSeries = (s > 0 || e > 0) || (movie && ((movie.number_of_seasons > 0) || (movie.first_air_date && !movie.release_date)));

        if (id) {
            var key = 'sync_movie_' + id;
            if (isSeries && (s > 0 || e > 0)) {
                key += '_s' + (s || 1) + '_e' + (e || 1);
            }
            return key.replace(/[\.\$#\[\]\/]/g, '_');
        }

        if (hash) {
            return ('sync_hash_' + hash).replace(/[\.\$#\[\]\/]/g, '_');
        }

        return null;
    }

    function extractMediaInfo(data) {
        var active = Lampa.Activity && Lampa.Activity.active && Lampa.Activity.active();
        var playData = Lampa.Player && Lampa.Player.playdata && Lampa.Player.playdata();
        var movie = (data && (data.movie || data.card)) ||
                    (active && (active.card || active.movie)) ||
                    (playData && (playData.card || playData.movie)) ||
                    {};

        var season = null;
        var episode = null;

        var sources = [
            data,
            data && data.timeline,
            playData,
            playData && playData.timeline
        ];

        for (var i = 0; i < sources.length; i++) {
            var src = sources[i];
            if (src) {
                if (season === null) {
                    if (typeof src.season !== 'undefined' && src.season !== null) season = src.season;
                    else if (typeof src.season_number !== 'undefined' && src.season_number !== null) season = src.season_number;
                }
                if (episode === null) {
                    if (typeof src.episode !== 'undefined' && src.episode !== null) episode = src.episode;
                    else if (typeof src.episode_number !== 'undefined' && src.episode_number !== null) episode = src.episode_number;
                }
            }
        }

        var title = movie.title || movie.name || movie.original_title || (data && (data.title || (data.timeline && data.timeline.title))) || '';

        return {
            movie: movie,
            season: season,
            episode: episode,
            title: title
        };
    }

    function getCurrentPlayerProgress() {
        var time = 0;
        var duration = 0;

        if (Lampa.PlayerVideo && Lampa.PlayerVideo.video) {
            try {
                var vid = Lampa.PlayerVideo.video();
                if (vid && vid.duration && !isNaN(vid.duration) && vid.duration > 0) {
                    time = vid.currentTime || 0;
                    duration = vid.duration || 0;
                }
            } catch (e) {}
        }

        if (!duration) {
            var video = document.querySelector('video');
            if (video && video.duration && !isNaN(video.duration) && video.duration > 0) {
                time = video.currentTime || 0;
                duration = video.duration || 0;
            }
        }

        if (!duration && Lampa.Player && Lampa.Player.playdata) {
            try {
                var pdata = Lampa.Player.playdata() || {};
                if (pdata.timeline) {
                    time = pdata.timeline.time || 0;
                    duration = pdata.timeline.duration || 0;
                }
            } catch (e) {}
        }

        if (duration > 0) {
            return {
                time: Math.round(time),
                duration: Math.round(duration),
                percent: Math.min(100, Math.round((time / duration) * 100))
            };
        }
        return null;
    }

    function sendProgress(force, customProgress) {
        if (!isSyncEnabled()) return;
        var syncCode = getSyncCode();
        if (!syncCode) return;

        var progress = customProgress || getCurrentPlayerProgress();
        if (!progress || progress.duration <= 0 || progress.time < 3) return;

        var now = Date.now();
        if (!force && (now - lastSentTimestamp < MIN_SEND_INTERVAL)) {
            return;
        }
        lastSentTimestamp = now;

        var key = currentContentKey;
        if (!key && currentHash) {
            key = hashToKey[currentHash] || ('sync_hash_' + currentHash);
        }
        if (!key) return;

        var payload = {
            time: Math.round(progress.time),
            duration: Math.round(progress.duration),
            percent: progress.percent,
            updated_at: now,
            hash: currentHash || '',
            title: currentMovieTitle || '',
            season: currentSeason || null,
            episode: currentEpisode || null
        };

        cachedProgress[key] = payload;
        if (currentHash) {
            cachedProgress[currentHash] = payload;
            hashToKey[currentHash] = key;
            keyToHash[key] = currentHash;
        }

        var url = getFirebaseEndpoint(syncCode, key);
        ajaxRequest('PATCH', url, payload, function () {});
    }

    function startSyncTimer() {
        stopSyncTimer();
        syncTimer = setInterval(function () {
            sendProgress(false);
        }, 12000);
    }

    function stopSyncTimer() {
        if (syncTimer) {
            clearInterval(syncTimer);
            syncTimer = null;
        }
    }

    function testConnection() {
        var code = getSyncCode();
        if (!code) {
            Lampa.Noty.show('Сначала задайте Код синхронизации в настройках!');
            return;
        }

        Lampa.Noty.show('Проверка соединения с Firebase...');
        var testUrl = cleanUrl(FIREBASE_URL) + '/users/' + encodeURIComponent(code) + '/_ping.json';

        var testData = {
            time: Date.now(),
            platform: Lampa.Platform && Lampa.Platform.is ? (Lampa.Platform.is('android') ? 'Android' : 'SmartTV/Browser') : 'Device'
        };

        ajaxRequest('PUT', testUrl, testData, function (err) {
            if (err) {
                Lampa.Noty.show('Ошибка соединения: проверьте вкладку Правила (Rules) в Firebase');
            } else {
                Lampa.Noty.show('Связь установлена! Код: ' + code);
            }
        });
    }

    // Обогащаем Timeline.view, сохраняя res.handler
    var originalTimelineView = Lampa.Timeline.view;
    Lampa.Timeline.view = function (target, meta) {
        var res = originalTimelineView ? originalTimelineView.apply(this, arguments) : null;
        var hash = typeof target === 'string' ? target : (target && target.hash);
        if (!res) res = { hash: hash, percent: 0, time: 0, duration: 0 };

        if (hash) {
            var key = hashToKey[hash] || hash;
            var cloud = cachedProgress[key] || cachedProgress[hash];
            if (cloud && cloud.time && (!res.time || cloud.time > res.time + 5)) {
                res.percent = cloud.percent;
                res.time = cloud.time;
                res.duration = cloud.duration;
            }
        }
        return res;
    };

    var originalTimelineUpdate = Lampa.Timeline.update;
    Lampa.Timeline.update = function (data) {
        if (originalTimelineUpdate) {
            originalTimelineUpdate.apply(this, arguments);
        }
        if (data && data.hash && currentContentKey) {
            hashToKey[data.hash] = currentContentKey;
            keyToHash[currentContentKey] = data.hash;
        }
    };

    var originalPlayerPlay = Lampa.Player.play;
    Lampa.Player.play = function (playData) {
        if (playData && isSyncEnabled()) {
            var info = extractMediaInfo(playData);
            var hash = (playData.timeline && playData.timeline.hash) || playData.hash;
            var key = getContentKey(info.movie, info.season, info.episode, hash);

            if (key && hash) {
                hashToKey[hash] = key;
                keyToHash[key] = hash;
            }

            var cloud = (key && cachedProgress[key]) || (hash && cachedProgress[hash]);
            if (cloud && cloud.time) {
                if (!playData.timeline) {
                    playData.timeline = {};
                }
                if (!playData.timeline.time || cloud.time > playData.timeline.time + 5) {
                    playData.timeline.time = cloud.time;
                    playData.timeline.duration = cloud.duration;
                    playData.timeline.percent = cloud.percent;
                }
            }
        }
        return originalPlayerPlay.apply(this, arguments);
    };

    function initPlayerListeners() {
        if (Lampa.Player && Lampa.Player.listener) {
            Lampa.Player.listener.follow('start', function (data) {
                var info = extractMediaInfo(data);
                var hash = (data && data.timeline && data.timeline.hash) || (data && data.hash) || '';
                currentHash = hash;
                currentMovieTitle = info.title;
                currentSeason = info.season;
                currentEpisode = info.episode;
                currentContentKey = getContentKey(info.movie, info.season, info.episode, hash);

                if (currentHash && currentContentKey) {
                    hashToKey[currentHash] = currentContentKey;
                    keyToHash[currentContentKey] = currentHash;
                }

                if (isSyncEnabled() && (currentContentKey || currentHash)) {
                    var syncCode = getSyncCode();
                    var lookupKey = currentContentKey || currentHash;
                    if (syncCode && lookupKey) {
                        var url = getFirebaseEndpoint(syncCode, lookupKey);
                        ajaxRequest('GET', url, null, function (err, cloudData) {
                            if (!err && cloudData && cloudData.time && cloudData.time > 5) {
                                cachedProgress[lookupKey] = cloudData;
                                if (currentHash) cachedProgress[currentHash] = cloudData;

                                var cur = getCurrentPlayerProgress();
                                var curTime = cur ? cur.time : 0;

                                if (cloudData.time > curTime + 5) {
                                    try {
                                        if (Lampa.PlayerVideo && Lampa.PlayerVideo.to) {
                                            Lampa.PlayerVideo.to(cloudData.time);
                                        } else if (Lampa.Player && Lampa.Player.to) {
                                            Lampa.Player.to(cloudData.time);
                                        }
                                    } catch (e) {}

                                    if (currentHash) {
                                        Lampa.Timeline.update({
                                            hash: currentHash,
                                            time: cloudData.time,
                                            duration: cloudData.duration,
                                            percent: cloudData.percent
                                        });
                                    }

                                    Lampa.Noty.show('Прогресс синхронизирован (' + formatTime(cloudData.time) + ')');
                                }
                            }
                        });
                    }
                }

                startSyncTimer();
            });

            Lampa.Player.listener.follow('destroy', function () {
                sendProgress(true);
                stopSyncTimer();
                currentContentKey = null;
                currentHash = null;
                currentMovieTitle = '';
                currentSeason = null;
                currentEpisode = null;
            });
        }

        // Отслеживаем паузу и таймкоды плеера
        if (Lampa.PlayerVideo && Lampa.PlayerVideo.listener) {
            Lampa.PlayerVideo.listener.follow('pause', function () {
                sendProgress(true);
            });
            Lampa.PlayerVideo.listener.follow('timeupdate', function (e) {
                if (e && e.duration && e.current > 3) {
                    sendProgress(false, {
                        time: e.current,
                        duration: e.duration,
                        percent: Math.min(100, Math.round((e.current / e.duration) * 100))
                    });
                }
            });
            Lampa.PlayerVideo.listener.follow('destroy', function () {
                sendProgress(true);
            });
        }

        // Отслеживаем любые обновления таймлайна Lampa
        if (Lampa.Timeline && Lampa.Timeline.listener) {
            Lampa.Timeline.listener.follow('update', function (e) {
                if (e && e.data && e.data.hash && e.data.road) {
                    var road = e.data.road;
                    if (road.time && road.time > 3 && road.duration) {
                        var h = e.data.hash;
                        var k = hashToKey[h] || currentContentKey || ('sync_hash_' + h);
                        var p = {
                            time: Math.round(road.time),
                            duration: Math.round(road.duration),
                            percent: road.percent || Math.round((road.time / road.duration) * 100)
                        };
                        var syncCode = getSyncCode();
                        if (isSyncEnabled() && syncCode) {
                            cachedProgress[k] = p;
                            cachedProgress[h] = p;
                            var u = getFirebaseEndpoint(syncCode, k);
                            ajaxRequest('PATCH', u, {
                                time: p.time,
                                duration: p.duration,
                                percent: p.percent,
                                updated_at: Date.now(),
                                hash: h,
                                title: currentMovieTitle || '',
                                season: currentSeason || null,
                                episode: currentEpisode || null
                            }, function () {});
                        }
                    }
                }
            });
        }
    }

    function initCardListener() {
        if (!Lampa.Listener) return;

        Lampa.Listener.follow('full', function (e) {
            if (e.type === 'complite' || e.data) {
                var movie = (e.data && (e.data.movie || e.data.card)) ||
                            (e.object && (e.object.movie || e.object.card));
                if (!movie || !isSyncEnabled()) return;

                var syncCode = getSyncCode();
                if (!syncCode) return;

                var id = movie.id || movie.kp_id || movie.imdb_id;
                var prefix = id ? ('sync_movie_' + id) : '';
                var allUrl = cleanUrl(FIREBASE_URL) + '/users/' + encodeURIComponent(syncCode) + '.json';

                ajaxRequest('GET', allUrl, null, function (err, allData) {
                    if (!err && allData && typeof allData === 'object') {
                        var restoredCount = 0;
                        var latestTime = 0;

                        for (var key in allData) {
                            if (allData.hasOwnProperty(key)) {
                                var match = prefix ? (key.indexOf(prefix) === 0) : false;
                                var cloud = allData[key];
                                if ((match || (cloud && cloud.hash)) && cloud && cloud.time && cloud.time > 5) {
                                    cachedProgress[key] = cloud;
                                    var h = cloud.hash || key;
                                    cachedProgress[h] = cloud;
                                    hashToKey[h] = key;

                                    var local = Lampa.Timeline.view(h);
                                    if (!local || !local.time || cloud.time > local.time + 5) {
                                        Lampa.Timeline.update({
                                            hash: h,
                                            time: cloud.time,
                                            duration: cloud.duration,
                                            percent: cloud.percent
                                        });

                                        restoredCount++;
                                        if (cloud.time > latestTime) latestTime = cloud.time;
                                    }
                                }
                            }
                        }

                        if (restoredCount > 0) {
                            Lampa.Noty.show('Синхронизирован прогресс (' + formatTime(latestTime) + ')');
                        }
                    }
                });
            }
        });
    }

    function initSettings() {
        if (!Lampa.SettingsApi) return;

        Lampa.SettingsApi.addComponent({
            component: 'tv_phone_sync',
            icon: '<svg height="36" viewBox="0 0 24 24" width="36" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h24v24H0z" fill="none"/><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" fill="currentColor"/></svg>',
            name: 'Синхронизация ТВ и Телефона'
        });

        Lampa.SettingsApi.addParam({
            component: 'tv_phone_sync',
            param: {
                name: 'tv_phone_sync_enabled',
                type: 'trigger',
                default: true
            },
            field: {
                name: 'Включить автосинхронизацию',
                description: 'Автоматически синхронизировать таймкоды через Firebase'
            },
            onChange: function (value) {
                Lampa.Storage.set('tv_phone_sync_enabled', value);
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'tv_phone_sync',
            param: {
                name: 'tv_phone_sync_code',
                type: 'input',
                values: '',
                placeholder: 'Например: dom2026',
                default: ''
            },
            field: {
                name: 'Код синхронизации',
                description: 'Одинаковое слово или цифры на ТВ и телефоне (например: dom2026)'
            },
            onChange: function (value) {
                var clean = (value || '').toString().trim().replace(/[^a-zA-Z0-9_\-]/g, '');
                Lampa.Storage.set('tv_phone_sync_code', clean);
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'tv_phone_sync',
            param: {
                name: 'tv_phone_sync_test',
                type: 'button'
            },
            field: {
                name: 'Проверить соединение / Синхронизировать сейчас',
                description: 'Проверить доступность облачной базы и применить таймкоды'
            },
            onChange: function () {
                testConnection();
            },
            onRender: function (item) {
                item.on('hover:enter click', function () {
                    testConnection();
                });
            }
        });
    }

    function startPlugin() {
        initSettings();
        initPlayerListeners();
        initCardListener();
    }

    if (window.appready) {
        startPlugin();
    } else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') {
                startPlugin();
            }
        });
    }
})();