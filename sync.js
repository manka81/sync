(function () {
        'use strict';

        var FIREBASE_URL = 'https://synx-332c2-default-
  rtdb.europe-west1.firebasedatabase.app';

        if (window.tv_phone_sync_plugin_loaded) return;
        window.tv_phone_sync_plugin_loaded = true;

        var hashToKey = {};
        var keyToHash = {};
        var cachedProgress = {};

        var currentContentKey = null;
        var currentHash = null;
        var currentMovieTitle = '';
        var syncTimer = null;
        var lastSentTimestamp = 0;
        var MIN_SEND_INTERVAL = 14000;

        function isSyncEnabled() {
            return Lampa.Storage.
  get('tv_phone_sync_enabled', true);
        }

        function getSyncCode() {
            var code = Lampa.Storage.
  get('tv_phone_sync_code', '');
            return (code || '').toString().trim().
  replace(/[^a-zA-Z0-9_\-]/g, '');
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
                return h + ':' + (m < 10 ? '0' : '') + m +
  ':' + (sec < 10 ? '0' : '') + sec;
            }
            return m + ':' + (sec < 10 ? '0' : '') + sec;
        }

        function ajaxRequest(method, url, data, callback)
  {
            try {
                var xhr = new XMLHttpRequest();
                xhr.open(method, url, true);
                xhr.timeout = 7000;
                xhr.setRequestHeader('Content-Type',
  'application/json; charset=utf-8');

                xhr.onreadystatechange = function () {
                    if (xhr.readyState === 4) {
                        if (xhr.status >= 200 && xhr.
  status < 300) {
                            var parsed = null;
                            try {
                                parsed = JSON.parse(xhr.
  responseText);
                            } catch (e) {
                                parsed = xhr.responseText;
                            }
                            if (callback) callback(null,
  parsed);
                        } else {
                            if (callback) callback(new
  Error('HTTP ' + xhr.status));
                        }
                    }
                };

                xhr.ontimeout = function () {
                    if (callback) callback(new
  Error('timeout'));
                };

                xhr.onerror = function () {
                    if (callback) callback(new
  Error('network error'));
                };

                xhr.send(data ? JSON.stringify(data) :
  null);
            } catch (e) {
                if (callback) callback(e);
            }
        }

        function getFirebaseEndpoint(syncCode,
  contentKey) {
            var base = cleanUrl(FIREBASE_URL);
            return base + '/users/' +
  encodeURIComponent(syncCode) + '/' +
  encodeURIComponent(contentKey) + '.json';
        }

        function getContentKey(movie, season, episode) {
            if (!movie) return null;

            var id = movie.id || movie.kp_id || movie.
  imdb_id;
            if (!id) {
                var title = movie.title || movie.name ||
  movie.original_title || '';
                id = title.toLowerCase().replace(/[^a-zа-
  я0-9]/gi, '_');
            }
            if (!id) return null;

            var s = parseInt(season, 10);
            var e = parseInt(episode, 10);
            var isSeries = (s > 0 || e > 0) || (movie.
  number_of_seasons > 0) || (movie.first_air_date &&
  !movie.release_date);

            var key = 'sync_movie_' + id;
            if (isSeries && (s > 0 || e > 0)) {
                key += '_s' + (s || 1) + '_e' + (e || 1);
            }

            return key.replace(/[\.\$#\[\]\/]/g, '_');
        }

        function extractMediaInfo(data) {
            var active = Lampa.Activity.active && Lampa.
  Activity.active();
            var movie = (data && data.movie) || (active
  && active.card) || {};
            var season = null;
            var episode = null;

            if (data) {
                if (typeof data.season !== 'undefined' &&
  data.season !== null) season = data.season;
                else if (data.timeline && typeof data.
  timeline.season !== 'undefined') season = data.
  timeline.season;

                if (typeof data.episode !== 'undefined'
  && data.episode !== null) episode = data.episode;
                else if (data.timeline && typeof data.
  timeline.episode !== 'undefined') episode = data.
  timeline.episode;
            }

            return {
                movie: movie,
                season: season,
                episode: episode,
                title: movie.title || movie.name || (data
  && data.title) || ''
            };
        }

        function getCurrentPlayerProgress() {
            var time = 0;
            var duration = 0;

            var video = document.querySelector('video');
            if (video && video.duration && !isNaN(video.
  duration) && video.duration > 0) {
                time = video.currentTime || 0;
                duration = video.duration || 0;
            }

            if (!duration && Lampa.Player.data) {
                var pdata = Lampa.Player.data() || {};
                if (pdata.timeline) {
                    time = pdata.timeline.time || 0;
                    duration = pdata.timeline.duration ||
  0;
                }
            }

            if (duration > 0) {
                return {
                    time: time,
                    duration: duration,
                    percent: Math.min(100, Math.
  round((time / duration) * 100))
                };
            }
            return null;
        }

        function sendProgress(force) {
            if (!isSyncEnabled()) return;
            var syncCode = getSyncCode();
            if (!syncCode || !currentContentKey) return;

            var now = Date.now();
            if (!force && (now - lastSentTimestamp <
  MIN_SEND_INTERVAL)) {
                return;
            }

            var progress = getCurrentPlayerProgress();
            if (!progress || progress.duration <= 0 ||
  progress.time < 3) {
                return;
            }

            lastSentTimestamp = now;

            var payload = {
                time: Math.round(progress.time),
                duration: Math.round(progress.duration),
                percent: progress.percent,
                updated_at: now,
                hash: currentHash || '',
                title: currentMovieTitle || ''
            };

            cachedProgress[currentContentKey] = payload;

            var url = getFirebaseEndpoint(syncCode,
  currentContentKey);
            ajaxRequest('PATCH', url, payload, function
  () {});
        }

        function startSyncTimer() {
            stopSyncTimer();
            syncTimer = setInterval(function () {
                sendProgress(false);
            }, 15000);
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
                Lampa.Noty.show('Сначала задайте Код
  синхронизации в настройках!');
                return;
            }

            Lampa.Noty.show('Проверка соединения с
  Firebase...');
            var testUrl = cleanUrl(FIREBASE_URL) +
  '/users/' + encodeURIComponent(code) + '/_ping.json';

            var testData = {
                time: Date.now(),
                platform: Lampa.Platform && Lampa.
  Platform.is ? (Lampa.Platform.is('android') ? 'Android'
  : 'SmartTV/Browser') : 'Device'
            };

            ajaxRequest('PUT', testUrl, testData,
  function (err) {
                if (err) {
                    Lampa.Noty.show('Ошибка соединения:
  проверьте вкладку Правила (Rules) в Firebase');
                } else {
                    Lampa.Noty.show('Связь установлена!
  Код: ' + code);
                }
            });
        }

        var originalTimelineView = Lampa.Timeline.view;
        Lampa.Timeline.view = function (target) {
            var res = originalTimelineView ?
  originalTimelineView.apply(this, arguments) : null;
            var hash = typeof target === 'string' ?
  target : (target && target.hash);

            if (hash) {
                var key = hashToKey[hash];
                if (key && cachedProgress[key]) {
                    var cloud = cachedProgress[key];
                    if (!res || !res.percent || cloud.
  time > (res.time || 0) + 10) {
                        return {
                            hash: hash,
                            percent: cloud.percent,
                            time: cloud.time,
                            duration: cloud.duration
                        };
                    }
                }
            }
            return res || { percent: 0, time: 0,
  duration: 0 };
        };

        var originalTimelineUpdate = Lampa.Timeline.
  update;
        Lampa.Timeline.update = function (data) {
            if (originalTimelineUpdate) {
                originalTimelineUpdate.apply(this,
  arguments);
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
                var key = getContentKey(info.movie, info.
  season, info.episode);
                var hash = (playData.timeline &&
  playData.timeline.hash) || playData.hash;

                if (key && hash) {
                    hashToKey[hash] = key;
                    keyToHash[key] = hash;
                }

                if (key && cachedProgress[key]) {
                    var cloud = cachedProgress[key];
                    if (!playData.timeline) {
                        playData.timeline = {};
                    }
                    if (cloud.time && (!playData.
  timeline.time || cloud.time > playData.timeline.time +
  10)) {
                        playData.timeline.time = cloud.
  time;
                        playData.timeline.duration =
  cloud.duration;
                        playData.timeline.percent =
  cloud.percent;
                    }
                }
            }
            return originalPlayerPlay.apply(this,
  arguments);
        };

        function initPlayerListeners() {
            if (!Lampa.Player || !Lampa.Player.listener)
  return;

            Lampa.Player.listener.follow('start',
  function (data) {
                var info = extractMediaInfo(data);
                currentContentKey = getContentKey(info.
  movie, info.season, info.episode);
                currentHash = (data && data.timeline &&
  data.timeline.hash) || (data && data.hash) || '';
                currentMovieTitle = info.title;

                if (currentHash && currentContentKey) {
                    hashToKey[currentHash] =
  currentContentKey;
                    keyToHash[currentContentKey] =
  currentHash;
                }

                if (isSyncEnabled() && currentContentKey)
  {
                    var syncCode = getSyncCode();
                    if (syncCode) {
                        var url =
  getFirebaseEndpoint(syncCode, currentContentKey);
                        ajaxRequest('GET', url, null,
  function (err, cloudData) {
                            if (!err && cloudData &&
  cloudData.time && cloudData.time > 10) {

  cachedProgress[currentContentKey] = cloudData;

                                var cur =
  getCurrentPlayerProgress();
                                var curTime = cur ? cur.
  time : 0;

                                if (cloudData.time >
  curTime + 10) {
                                    try {
                                        Lampa.Player.
  to(cloudData.time);
                                    } catch (e) {}

                                    if (currentHash) {
                                        Lampa.Timeline.
  update({
                                            hash:
  currentHash,
                                            time:
  cloudData.time,
                                            duration:
  cloudData.duration,
                                            percent:
  cloudData.percent
                                        });
                                    }

                                    Lampa.Noty.
  show('Прогресс загружен с другого устройства (' +
  formatTime(cloudData.time) + ')');
                                }
                            }
                        });
                    }
                }

                var video = document.
  querySelector('video');
                if (video && !video.__sync_attached) {
                    video.__sync_attached = true;
                    video.addEventListener('pause',
  function () {
                        sendProgress(true);
                    });
                    video.addEventListener('ended',
  function () {
                        sendProgress(true);
                    });
                }

                startSyncTimer();
            });

            Lampa.Player.listener.follow('pause',
  function () {
                sendProgress(true);
            });

            Lampa.Player.listener.follow('destroy',
  function () {
                sendProgress(true);
                stopSyncTimer();
                currentContentKey = null;
                currentHash = null;
                currentMovieTitle = '';
            });
        }

        function initCardListener() {
            if (!Lampa.Listener) return;

            Lampa.Listener.follow('full', function (e) {
                if (e.type === 'complite' || e.data) {
                    var movie = (e.data && e.data.movie) ||
  (e.object && e.object.movie);
                    if (!movie || !isSyncEnabled())
  return;

                    var syncCode = getSyncCode();
                    if (!syncCode) return;

                    var id = movie.id || movie.kp_id ||
  movie.imdb_id;
                    if (!id) return;

                    var prefix = 'sync_movie_' + id;
                    var allUrl = cleanUrl(FIREBASE_URL) +
  '/users/' + encodeURIComponent(syncCode) + '.json';

                    ajaxRequest('GET', allUrl, null,
  function (err, allData) {
                        if (!err && allData && typeof
  allData === 'object') {
                            var restoredCount = 0;
                            var latestTime = 0;

                            for (var key in allData) {
                                if (allData.
  hasOwnProperty(key) && key.indexOf(prefix) === 0) {
                                    var cloud =
  allData[key];
                                    if (cloud && cloud.
  time && cloud.time > 10) {

  cachedProgress[key] = cloud;

                                        var local =
  Lampa.Timeline.view(key);
                                        if (!local ||
  !local.time || cloud.time > local.time + 10) {
                                            Lampa.
  Timeline.update({
                                                hash: key,
                                                time:
  cloud.time,
                                                duration:
  cloud.duration,
                                                percent:
  cloud.percent
                                            });

                                            if (cloud.
  hash) {

  hashToKey[cloud.hash] = key;
                                                Lampa.
  Timeline.update({
                                                    hash:
  cloud.hash,
                                                    time:
  cloud.time,

  duration: cloud.duration,

  percent: cloud.percent
                                                });
                                            }


restoredCount++;
                                            if (cloud.
  time > latestTime) latestTime = cloud.time;
                                        }
                                    }
                                }
                            }

                            if (restoredCount > 0) {
                                Lampa.Noty.
  show('Синхронизирован прогресс (' +
  formatTime(latestTime) + ')');
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
                icon: '<svg height="36" viewBox="0 0 24
  24" width="36" xmlns="http://www.w3.org/2000/svg"><path
  d="M0 0h24v24H0z" fill="none"/><path d="M12 4V1L8 5l4
  4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.
  46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-
  3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46
  8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"
  fill="currentColor"/></svg>',
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
                    description: 'Автоматически
  синхронизировать таймкоды через Firebase'
                },
                onChange: function (value) {
                    Lampa.Storage.
  set('tv_phone_sync_enabled', value);
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'tv_phone_sync',
                param: {
                    name: 'tv_phone_sync_code',
                    type: 'input',
                    default: ''
                },
                field: {
                    name: 'Код синхронизации',
                    description: 'Одинаковое слово или
  цифры на ТВ и телефоне (например: dom2026)'
                },
                onChange: function (value) {
                    var clean = (value || '').toString().
  trim().replace(/[^a-zA-Z0-9_\-]/g, '');
                    Lampa.Storage.
  set('tv_phone_sync_code', clean);
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'tv_phone_sync',
                param: {
                    name: 'tv_phone_sync_test',
                    type: 'button'
                },
                field: {
                    name: 'Проверить соединение /
  Синхронизировать сейчас',
                    description: 'Проверить доступность
  облачной базы и применить таймкоды'
                },
                onChange: function () {
                    testConnection();
                },
                onRender: function (item) {
                    item.on('hover:enter click', function
  () {
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
