'use strict';

const http = require('node:http');
const https = require('node:https');

const UPnP = require('upnp-client-ts');
const convert = require('xml-js')

const { MyHttpDevice } = require('my-homey');

module.exports = class PlayerDevice extends MyHttpDevice {

  #upnpClient
  #albumArtImage
  #currentAlbumURI = ''

  async onInit() {
    super.onInit();

    this.registerFlows();

    this.registerCapabilityListener('speaker_playing', this.onCapabilitySpeakerPlaying.bind(this));
    this.registerCapabilityListener('speaker_prev', this.onCapabilitySpeakerPrev.bind(this));
    this.registerCapabilityListener('speaker_next', this.onCapabilitySpeakerNext.bind(this));
    this.registerCapabilityListener('speaker_shuffle', this.onCapabilitySpeakerShuffle.bind(this));
    this.registerCapabilityListener('speaker_repeat', this.onCapabilitySpeakerRepeat.bind(this));
    this.registerCapabilityListener('volume_set', this.onCapabilityVolumeSet.bind(this));
    this.registerCapabilityListener('volume_mute', this.onCapabilityVolumeMute.bind(this));

    this.registerDeviceListener('GetInfoEx', this.onDeviceGetInfoEx.bind(this));

    this.#albumArtImage = await this.homey.images.createImage();
    this.#albumArtImage.setUrl(null)
    this.setAlbumArtImage(this.#albumArtImage)
      .catch((err) => this.logError(`onInit() > AlbumArtImage > ${err.message}`));

    this.#upnpClient = new UPnP.UpnpDeviceClient(`http://${this.getStoreValue('address')}:49152/description.xml`);
    // FIXME: Workaround until "subscribe > renew" is fixed
    // this.#upnpClient.subscribe('AVTransport', (event) => {
    //   this.logDebug(`onInit() > subscribe > AVTransport`)
    //   this.getDeviceValues()
    // })
    this.homey.setInterval(() => this.getDeviceValues(), 5000)
  }

  // FIXME: simplelog-api on/off
  logDebug(msg) {
    if (process.env.DEBUG === '1') {
      super.logDebug(msg);
    }
  }

  registerFlows() {
    this.logDebug('registerFlows()')
  }

  // MyHttpDevice

  getHttpConfig() {
    return {
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    };
  }

  getBaseURL() {
    return `https://${this.getStoreValue('address')}`;
  }

  sendCommand(url) {
    return super.sendCommand(`/httpapi.asp?command=${url}`);
  }

  getDeviceValues(url = '**UPnP**') {
    return super.getDeviceValues(url)
  }

  async getDeviceData(url) {
    this.logDebug(`getDeviceData()`);

    return Promise.resolve({})
      .then(async () => {
        const value = await this.#upnpClient.callAction('AVTransport', 'GetInfoEx', { InstanceID: 0 })
        this.deviceDataReceived('GetInfoEx', value)
      })
  }

  //
  // Capability handling
  //

  onCapabilitySpeakerPlaying(value, opts) {
    this.logDebug(`onCapabilitySpeakerPlaying() > ${value} opts: ${JSON.stringify(opts)}`);

    if (value) {
      return this.sendCommand('setPlayerCmd:resume')
        .catch((error) => this.logError(`onCapabilitySpeakerPlaying() > sendCommand > ${error}`))
    } else {
      // return this.sendCommand('setPlayerCmd:stop')
      return this.sendCommand('setPlayerCmd:pause')
        .catch((error) => this.logError(`onCapabilitySpeakerPlaying() > sendCommand > ${error}`))
    }
  }

  onCapabilitySpeakerPrev() {
    this.logDebug(`onCapabilitySpeakerPrev()`);

    return this.sendCommand('setPlayerCmd:prev')
      .catch((error) => this.logError(`onCapabilitySpeakerPrev() > sendCommand > ${error}`))
  }

  onCapabilitySpeakerNext() {
    this.logDebug(`onCapabilitySpeakerNext()`);

    return this.sendCommand('setPlayerCmd:next')
      .catch((error) => this.logError(`onCapabilitySpeakerNext() > sendCommand > ${error}`))
  }

  onCapabilitySpeakerShuffle(shuffle, opts) {
    this.logDebug(`onCapabilitySpeakerShuffle() > ${value} opts: ${JSON.stringify(opts)}`);

    const loopMode = this.#convertToLoopMode(shuffle, this.getCapabilityValue('speaker_repeat'));

    return this.sendCommand(`setPlayerCmd:loopmode:${loopMode}`)
      .catch((error) => this.logError(`onCapabilitySpeakerShuffle() > sendCommand > ${error}`))
  }

  onCapabilitySpeakerRepeat(repeat, opts) {
    this.logDebug(`onCapabilitySpeakerRepeat() > ${value} opts: ${JSON.stringify(opts)}`)

    const loopMode = this.#convertToLoopMode(this.getCapabilityValue('speaker_shuffle'), repeat);

    return this.sendCommand(`setPlayerCmd:loopmode:${loopMode}`)
      .catch((error) => this.logError(`onCapabilitySpeakerRepeat() > sendCommand > ${error}`))
  }

  onCapabilityVolumeSet(value, opts) {
    this.logDebug(`onCapabilityVolumeSet() > ${value} opts: ${JSON.stringify(opts)}`)

    return this.sendCommand(`setPlayerCmd:vol:${value * 100}`)
      .catch((error) => this.logError(`onCapabilityVolumeSet() > sendCommand > ${error}`))
  }

  onCapabilityVolumeMute(value, opts) {
    this.logDebug(`onCapabilityVolumeMute() > ${value} opts: ${JSON.stringify(opts)}`)

    return this.sendCommand(`setPlayerCmd:mute:${value ? '1' : '0'}`)
      .catch((error) => this.logError(`onCapabilityVolumeMute() > sendCommand > ${error}`))
  }

  //
  // Device handling
  //

  onDeviceGetInfoEx(value) {
    const data = { ...value }
    try {
      data.TrackMetaData = this.#convertXmlToJSON(data.TrackMetaData)['DIDL-Lite'].item;

      this.logDebug(`onDeviceGetInfoEx() > ${JSON.stringify(data)}`)

      const uri = data.TrackMetaData['upnp:albumArtURI']
      if (this.#currentAlbumURI !== uri) {
        this.logDebug(`onDeviceGetInfoEx() > AlbumArtImage > ${uri}`)

        this.#albumArtImage.setStream((stream) => {
          const func = uri.startsWith('https://') ? https.get : http.get
          func(uri, (resp) => { resp.pipe(stream) })
            .on('error', (err) => { throw err });
        })

        this.#albumArtImage.update()
          .catch((err) => this.logError(`onDeviceGetInfoEx() > AlbumArtImage > ${err.message}`));

        this.#currentAlbumURI = uri
      }

      const playing = data.CurrentTransportState === "PLAYING"
      this.setCapabilityValue('speaker_playing', playing)

      const artist = data.TrackMetaData['dc:subtitle'] ? data.TrackMetaData['dc:title'] : `${data.TrackMetaData['upnp:artist']}, ${data.TrackMetaData['upnp:album']}`
      this.setCapabilityValue('speaker_artist', artist)

      const album = data.TrackMetaData['dc:subtitle'] ? data.TrackMetaData['dc:title'] : data.TrackMetaData['upnp:album']
      this.setCapabilityValue('speaker_album', album)

      const track = data.TrackMetaData['dc:subtitle'] ? data.TrackMetaData['dc:subtitle'] : data.TrackMetaData['dc:title']
      this.setCapabilityValue('speaker_track', track)

      this.setCapabilityValue('speaker_duration', this.#convertTimeToNumber(data['TrackDuration']))
      this.setCapabilityValue('speaker_position', this.#convertTimeToNumber(data['RelTime']))

      switch (data['LoopMode']) {
        case "0":
          this.setCapabilityValue('speaker_shuffle', false)
          this.setCapabilityValue('speaker_repeat', 'playlist')
          break;
        case "1":
          this.setCapabilityValue('speaker_shuffle', false)
          this.setCapabilityValue('speaker_repeat', 'track')
          break;
        case "2":
          this.setCapabilityValue('speaker_shuffle', true)
          this.setCapabilityValue('speaker_repeat', 'playlist')
          break;
        case "3":
          this.setCapabilityValue('speaker_shuffle', true)
          this.setCapabilityValue('speaker_repeat', 'none')
          break;
        case "4":
          this.setCapabilityValue('speaker_shuffle', false)
          this.setCapabilityValue('speaker_repeat', 'none')
          break;
        case "5":
          this.setCapabilityValue('speaker_shuffle', true)
          this.setCapabilityValue('speaker_repeat', 'track')
          break;
        default:
          this.logError(`onDeviceGetInfoEx() > LoopMode not found > ${data['LoopMode']}`)
          break;
      }

      this.setCapabilityValue('volume_set', data['CurrentVolume'] / 100)
      this.setCapabilityValue('volume_mute', data['CurrentMute'] === '1' ? true : false)

    } catch (err) {
      // FIXME: See: WiiM Support ticket #503478
      if (process.env.DEBUG === '1') this.logError(`onDeviceGetInfoEx() > ${err.message} > ${JSON.stringify(value)}`)
    }
  }

  // Helper

  #convertToLoopMode(shuffle, repeat) {
    let loopMode = '??' // DummyVal

    if (shuffle === true && repeat === 'none') {
      loopMode = '3'
    } else if (shuffle === true && repeat === 'playlist') {
      loopMode = '2'
    } else if (shuffle === true && repeat === 'track') {
      loopMode = '5'
    } else if (shuffle === false && repeat === 'none') {
      loopMode = '4'
    } else if (shuffle === false && repeat === 'playlist') {
      loopMode = '0'
    } else if (shuffle === false && repeat === 'track') {
      loopMode = '1'
    }

    return loopMode
  }

  #convertTimeToNumber(time) {
    const val = time.split(':')
    return val[0] * 216000 + val[1] * 3600 + val[2] * 60
  }

  #convertXmlToJSON(val) {
    const nativeType = function (value) {
      let nValue = Number(value);
      if (!isNaN(nValue)) {
        return nValue;
      }
      let bValue = value.toLowerCase();
      if (bValue === 'true') {
        return true;
      } else if (bValue === 'false') {
        return false;
      }
      return value;
    }
    const removeJsonTextAttribute = function (value, parentElement) {
      try {
        const parentOfParent = parentElement._parent;
        const pOpKeys = Object.keys(parentElement._parent);
        const keyNo = pOpKeys.length;
        const keyName = pOpKeys[keyNo - 1];
        const arrOfKey = parentElement._parent[keyName];
        const arrOfKeyLen = arrOfKey.length;
        if (arrOfKeyLen > 0) {
          const arr = arrOfKey;
          const arrIndex = arrOfKey.length - 1;
          arr[arrIndex] = value;
        } else {
          parentElement._parent[keyName] = nativeType(value);
        }
      } catch (e) { }
    };

    const options = {
      compact: true,
      nativeType: false,
      compact: true,
      trim: true,
      ignoreDeclaration: true,
      ignoreInstruction: true,
      ignoreAttributes: true,
      ignoreComment: true,
      ignoreCdata: true,
      ignoreDoctype: true,
      textFn: removeJsonTextAttribute
    };

    return JSON.parse(convert.xml2json(val, options).replaceAll(':{}', ':""'))
  }

};
