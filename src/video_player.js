const request = require('request');
const Hls = require('hls.js');

const ENUM_TYPE_HLS = 'HLS';
const ENUM_TYPE_MPEGDASH = 'MPD';
const ENUM_TYPE_NO_CONTENT_TYPE = 'BAD_CONTENT_TYPE';

const TIME_SERIES_BUFFER_SIZE = 20;

const CONTENT_TYPE_MAP = {
  'application/x-mpegURL': ENUM_TYPE_HLS,
  'application/octet-stream': ENUM_TYPE_NO_CONTENT_TYPE,
  'binary/octet-stream': ENUM_TYPE_NO_CONTENT_TYPE,
  'application/vnd.apple.mpegurl': ENUM_TYPE_HLS,
  'application/dash+xml': ENUM_TYPE_MPEGDASH,
  'application/vnd.apple.mpegurl;charset=UTF-8': ENUM_TYPE_HLS,
};

class VideoPlayer {
  constructor(videoElement, uri) {
    this._uri = uri;
    this._videoElement = videoElement;
    this._codecMetadata;
    this._abrMetadata;
    this._abrTimeSeries = [];
    this._levelBucketCount = 0;
    this._abrStats = {
      totalChunkCount: 0,
      totalChunkDuration: 0,
      totalChunkSizeKB: 0,
      totalLoadTimeSec: 0,
      totalChunkBitrateKbps: 0,
    }
  }

  init() {
    return new Promise((resolve, reject) => {
      this._validateUrl(this._uri).then(() => {
        return this._determineType(this._uri);
      }).then(type => {
        let playerPromise;
        this._playerTechType = type;
        if (this._playerTechType === ENUM_TYPE_HLS) {
          playerPromise = this._initiateHlsPlayer();
        } else if (this._playerTechType === ENUM_TYPE_MPEGDASH) {
          playerPromise = this._initiateDashPlayer();
        } else {
          reject(`No player tech available for type '${type}'`);
        }
        return playerPromise;
      }).then(() => {
        resolve();
      }).catch(reject);
    });
  }

  play() {
    this._videoElement.play();
  }

  get codecMetadata() {
    return this._codecMetadata;
  }

  get abrMetadata() {
    return this._abrMetadata;
  }

  get abrTimeSeriesData() {
    return this._abrTimeSeries;
  }

  _initiateDashPlayer() {
    return new Promise((resolve, reject) => {
      const shakap = new shaka.Player(this._videoElement);
      console.log('Using shaka (MPEG-DASH)');

      shakap.addEventListener('error', ev => {
        console.error(ev);
      });

      shakap.addEventListener('segmentloaded', ev => {
        //console.log(ev);
        const variantTracks = shakap.getVariantTracks().filter(t => t.primary).sort((a, b) => a.height - b.height);
        let activeLevel = -1;
        for(let l = 0; l < variantTracks.length; l++) {
          const level = variantTracks[l];
          if (level.active) {
            activeLevel = l;
            break;
          }
        }
        if (!this._levelBucketCount) {
          this._levelBucketCount = variantTracks.length;
        }
        if (ev.detail.duration) {
          this._pushAbrTimeSeriesData({
            levelBucket: activeLevel,
            levelBucketCount: this._levelBucketCount,
            loadTimeMs: ev.detail.loadTime,
            sizeBytes: ev.detail.size,
            durationSec: ev.detail.duration,
          });

          this._abrStats.totalChunkCount++;
          this._abrStats.totalChunkDuration += ev.detail.duration;
          this._abrStats.totalChunkSizeKB += (ev.detail.size / 1000);
          this._abrStats.totalLoadTimeSec += (ev.detail.loadTime / 1000);
          const chunkBitrate = (ev.detail.size * 8) / ev.detail.duration;
          this._abrStats.totalChunkBitrateKbps += (chunkBitrate / 1000);
          if (this._abrMetadata) {
            //console.log(ev.detail, this._abrStats);
            this._abrMetadata.stats = {
              chunksDownloaded: this._abrStats.totalChunkCount,
              averageChunkDuration: this._abrStats.totalChunkDuration / this._abrStats.totalChunkCount,
              averageChunkSizeKB: this._abrStats.totalChunkSizeKB / this._abrStats.totalChunkCount,
              averageLoadTime: this._abrStats.totalLoadTimeSec / this._abrStats.totalChunkCount,
              averageChunkBitrateKbps: this._abrStats.totalChunkBitrateKbps / this._abrStats.totalChunkCount,
            };
          }
        }
      });

      shakap.addEventListener('sourcebufferinitiated', ev => {
        //console.log(ev);
        const audioMimeType = ev.detail.audioMimeType.split('; ');
        const videoMimeType = ev.detail.videoMimeType.split('; ');
        let audioCodec;
        let videoCodec;
        let m = audioMimeType[1].match(/codecs="(.*)"$/);
        if (m) {
          audioCodec = m[1];
        }
        m = videoMimeType[1].match(/codecs="(.*)"$/);
        if (m) {
          videoCodec = m[1];
        }
        this._codecMetadata = {
          audio: {
            container: audioMimeType[0],
            codec: audioCodec,
            channels: ev.detail.audioChannels,
          },
          video: {
            container: videoMimeType[0],
            codec: videoCodec,
            resolution: '',
          },
        };
      });

      shakap.load(this._uri).then(() => {
        console.log('Shaka player loaded manifest');
        const variantTracks = shakap.getVariantTracks().filter(t => t.primary).sort((a, b) => a.height - b.height);
        console.log(variantTracks);

        let availableLevels = [];
        variantTracks.forEach(t => {
          const codecsArray = t.codecs.split(', ');
          const vc = codecsArray[0];
          const ac = codecsArray[1];
          availableLevels.push({
            bitrate: t.bandwidth,
            resolution: t.width + 'x' + t.height,
            videoCodec: vc,
            audioCodec: ac,
          });
        });
        this._levelBucketCount = variantTracks.length;
        this._abrMetadata = {
          availableLevels,
        };

        resolve();
      }).catch(error => {
        console.error(error);
        reject(error.code);
      });
    });
  }

  _initiateHlsPlayer() {
    return new Promise((resolve, reject) => {
      const hls = new Hls({
        enableWorker: true,
      });
      this._playerTech = hls;

      hls.attachMedia(this._videoElement);
      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        console.log('Video element attached');
        hls.loadSource(this._uri);
      });

      hls.on(Hls.Events.BUFFER_CODECS, (event, data) => {
        //console.log(data);
        this._codecMetadata = {
          audio: {
            container: data.audio.container,
            codec: data.audio.codec,
            channels: data.audio.metadata.channelCount,
          },
          video: {
            container: data.video.container,
            codec: data.video.codec,
            resolution: data.video.metadata.width + 'x' + data.video.metadata.height,
          },
        };
      });

      hls.on(Hls.Events.FRAG_LOADED, (event, data) => {
        //console.log(data);
        this._pushAbrTimeSeriesData({
          levelBucket: data.frag.level,
          levelBucketCount: this._levelBucketCount,
          loadTimeMs: data.stats.tload - data.stats.trequest,
          sizeBytes: data.stats.total,
          durationSec: data.frag.duration,
        });
        this._abrStats.totalChunkCount++;
        this._abrStats.totalChunkDuration += data.frag.duration;
        this._abrStats.totalChunkSizeKB += (data.stats.total / 1000);
        this._abrStats.totalLoadTimeSec += ((data.stats.tload - data.stats.trequest) / 1000);
        const chunkBitrate = (data.stats.total * 8) / data.frag.duration;
        this._abrStats.totalChunkBitrateKbps += (chunkBitrate / 1000);
        if (this._abrMetadata) {
          this._abrMetadata.stats = {
            chunksDownloaded: this._abrStats.totalChunkCount,
            averageChunkDuration: this._abrStats.totalChunkDuration / this._abrStats.totalChunkCount,
            averageChunkSizeKB: this._abrStats.totalChunkSizeKB / this._abrStats.totalChunkCount,
            averageLoadTime: this._abrStats.totalLoadTimeSec / this._abrStats.totalChunkCount,
            averageChunkBitrateKbps: this._abrStats.totalChunkBitrateKbps / this._abrStats.totalChunkCount,
          };
        }
      });

      hls.on(Hls.Events.ERROR, function (event, data) {
        if (data.fatal) {
          console.error(data);
        }
      });

      hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
        console.log('Manifest parsed');
        console.log(data);

        let availableLevels = [];
        data.levels.forEach(l => {
          availableLevels.push({
            bitrate: l.bitrate,
            resolution: l.width + 'x' + l.height,
            videoCodec: l.videoCodec,
            audioCodec: l.audioCodec,
          });
        });
        this._levelBucketCount = availableLevels.length;
        this._abrMetadata = {
          availableLevels,
        };

        resolve();
      });
    });
  }

  _pushAbrTimeSeriesData(d) {
    d.timeSeriesBufferSize = TIME_SERIES_BUFFER_SIZE;
    this._abrTimeSeries.push(d);
    if (this._abrTimeSeries.length > TIME_SERIES_BUFFER_SIZE) {
      this._abrTimeSeries.shift();
    }
  }

  _validateUrl(uri) {
    return new Promise((resolve, reject) => {
      resolve();
    });
  }

  _determineType(uri) {
    return new Promise((resolve, reject) => {
      request(uri, (err, resp, body) => {
        if (resp.statusCode !== 200) {
          reject('Stream not found');
        } else {
          let type = CONTENT_TYPE_MAP[resp.headers['content-type']];
          if (!type) {
            reject(`Unsupported content '${resp.headers['content-type']}'`);
          } else {
            if (type === ENUM_TYPE_NO_CONTENT_TYPE) {
              if (uri.match(/\.m3u8/)) {
                type = ENUM_TYPE_HLS;
              } else if (uri.match(/\.mpd/)) {
                type = ENUM_TYPE_MPEGDASH;
              }
            }
            resolve(type);
          }
        }
      });
    });
  }
}

module.exports = VideoPlayer;