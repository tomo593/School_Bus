const wsClient = require('../../utils/ws');

const app = getApp();

const CAMPUS_CENTER = {
  latitude: 33.123456,
  longitude: 151.123456
};

const AUTO_FOLLOW_BUS_ID = 'BUS_01';
const MARKER_ANIMATION_DURATION = 1500;
const CALLOUT_AUTO_HIDE_DURATION = 5000;

const BUS_META = {
  BUS_01: {
    markerId: 1,
    labelBgColor: '#e0f2fe',
    labelColor: '#075985'
  },
  BUS_02: {
    markerId: 2,
    labelBgColor: '#dcfce7',
    labelColor: '#166534'
  },
  BUS_03: {
    markerId: 3,
    labelBgColor: '#fef3c7',
    labelColor: '#92400e'
  }
};

const INITIAL_BUSES = [
  {
    bus_id: 'BUS_01',
    lat: 33.123456,
    lng: 151.123456,
    speed: 0,
    timestamp: Math.floor(Date.now() / 1000)
  },
  {
    bus_id: 'BUS_02',
    lat: 33.124056,
    lng: 151.122856,
    speed: 0,
    timestamp: Math.floor(Date.now() / 1000)
  },
  {
    bus_id: 'BUS_03',
    lat: 33.122956,
    lng: 151.124156,
    speed: 0,
    timestamp: Math.floor(Date.now() / 1000)
  }
];

Page({
  data: {
    centerLat: CAMPUS_CENTER.latitude,
    centerLng: CAMPUS_CENTER.longitude,
    scale: 17,
    markers: [],
    busList: [],
    connectionText: '连接中',
    connectionState: 'connecting',
    modeText: 'WebSocket'
  },

  mapCtx: null,
  busStore: {},
  selectedBusId: '',
  markerSyncTimers: {},
  calloutTimer: null,
  unsubscribeMessage: null,

  onLoad() {
    this.mapCtx = wx.createMapContext('campusMap', this);
    this.initBuses();

    this.unsubscribeMessage = wsClient.onMessage(this.handleSocketMessage.bind(this));
    wsClient.connect({
      url: app.globalData.wsUrl,
      enableMock: app.globalData.enableMock
    });
  },

  onUnload() {
    if (this.unsubscribeMessage) {
      this.unsubscribeMessage();
      this.unsubscribeMessage = null;
    }

    Object.keys(this.markerSyncTimers).forEach((busId) => {
      clearTimeout(this.markerSyncTimers[busId]);
    });
    this.markerSyncTimers = {};

    if (this.calloutTimer) {
      clearTimeout(this.calloutTimer);
      this.calloutTimer = null;
    }

    wsClient.close();
  },

  initBuses() {
    INITIAL_BUSES.forEach((bus) => {
      this.busStore[bus.bus_id] = {
        ...bus,
        rotation: 0
      };
    });

    this.refreshBusList();
    this.refreshAllMarkers();
  },

  handleSocketMessage(message) {
    if (!message) {
      return;
    }

    if (message.type) {
      this.handleSocketStatus(message);
      return;
    }

    if (Array.isArray(message)) {
      message.forEach((bus) => this.updateBusPosition(bus));
      return;
    }

    this.updateBusPosition(message);
  },

  handleSocketStatus(message) {
    switch (message.type) {
      case 'socket_open':
        this.setData({
          connectionText: '已连接',
          connectionState: 'connected',
          modeText: 'WebSocket'
        });
        break;
      case 'mock_start':
        this.setData({
          connectionText: '模拟数据',
          connectionState: 'mock',
          modeText: 'Mock'
        });
        break;
      case 'socket_error':
      case 'socket_close':
        this.setData({
          connectionText: '重连中',
          connectionState: 'connecting'
        });
        break;
      default:
        break;
    }
  },

  updateBusPosition(rawBus) {
    const bus = this.normalizeBusData(rawBus);

    if (!bus || !this.getBusMeta(bus.bus_id)) {
      return;
    }

    const prevBus = this.busStore[bus.bus_id];
    const rotation = prevBus ? this.getBearing(prevBus, bus) : 0;
    const nextBus = {
      ...bus,
      rotation
    };

    this.busStore[bus.bus_id] = nextBus;
    this.refreshBusList();
    this.moveMarkerSmoothly(bus.bus_id, prevBus, nextBus);

    if (bus.bus_id === AUTO_FOLLOW_BUS_ID) {
      this.followBus(nextBus);
    }
  },

  normalizeBusData(rawBus) {
    if (!rawBus || !rawBus.bus_id) {
      return null;
    }

    const lat = Number(rawBus.lat);
    const lng = Number(rawBus.lng);
    const speed = Number(rawBus.speed || 0);
    const timestamp = Number(rawBus.timestamp || Math.floor(Date.now() / 1000));

    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      return null;
    }

    return {
      bus_id: String(rawBus.bus_id),
      lat,
      lng,
      speed,
      timestamp
    };
  },

  getBusMeta(busId) {
    return BUS_META[busId] || null;
  },

  moveMarkerSmoothly(busId, prevBus, nextBus) {
    const meta = this.getBusMeta(busId);

    if (!prevBus || this.isLongJump(prevBus, nextBus)) {
      this.replaceMarker(busId, nextBus);
      return;
    }

    const destination = {
      latitude: nextBus.lat,
      longitude: nextBus.lng
    };

    clearTimeout(this.markerSyncTimers[busId]);

    try {
      this.mapCtx.translateMarker({
        markerId: meta.markerId,
        destination,
        autoRotate: false,
        rotate: nextBus.rotation,
        duration: MARKER_ANIMATION_DURATION,
        animationEnd: () => {
          this.replaceMarker(busId, nextBus);
        },
        fail: () => {
          this.replaceMarker(busId, nextBus);
        }
      });

      // translateMarker 只移动原生地图层，动画结束后同步 data，保持下一次动画起点准确。
      this.markerSyncTimers[busId] = setTimeout(() => {
        this.replaceMarker(busId, nextBus);
      }, MARKER_ANIMATION_DURATION + 120);
    } catch (error) {
      this.replaceMarker(busId, nextBus);
    }
  },

  replaceMarker(busId, bus) {
    const meta = this.getBusMeta(busId);
    const nextMarker = this.createMarker(bus, meta);
    const markers = this.data.markers.slice();
    const index = markers.findIndex((marker) => marker.id === meta.markerId);

    if (index >= 0) {
      markers[index] = nextMarker;
    } else {
      markers.push(nextMarker);
    }

    this.setData({
      markers
    });
  },

  refreshAllMarkers() {
    const markers = Object.keys(this.busStore).map((busId) => {
      const bus = this.busStore[busId];
      const meta = this.getBusMeta(busId);
      return this.createMarker(bus, meta);
    });

    this.setData({
      markers
    });
  },

  createMarker(bus, meta) {
    const isSelected = bus.bus_id === this.selectedBusId;

    return {
      id: meta.markerId,
      latitude: bus.lat,
      longitude: bus.lng,
      iconPath: '/assets/bus.png',
      width: 42,
      height: 42,
      rotate: bus.rotation || 0,
      label: {
        content: bus.bus_id,
        color: meta.labelColor,
        fontSize: 12,
        bgColor: meta.labelBgColor,
        padding: 5,
        borderRadius: 5,
        anchorX: -24,
        anchorY: -54
      },
      callout: {
        content: this.getCalloutText(bus),
        color: '#132238',
        fontSize: 13,
        borderRadius: 6,
        bgColor: '#ffffff',
        padding: 8,
        display: isSelected ? 'ALWAYS' : 'BYCLICK',
        textAlign: 'center'
      }
    };
  },

  refreshBusList() {
    const busList = Object.keys(BUS_META).map((busId) => {
      const bus = this.busStore[busId] || {};
      const running = Number(bus.speed || 0) > 1;
      const active = busId === this.selectedBusId;

      return {
        bus_id: busId,
        speed: Math.round(Number(bus.speed || 0)),
        status: running ? '运行中' : '静止',
        statusClass: running ? 'status-running' : 'status-stopped',
        updateTime: bus.timestamp ? this.formatTime(bus.timestamp) : '--:--:--',
        rowClass: active ? 'is-active' : ''
      };
    });

    this.setData({
      busList
    });
  },

  followBus(bus) {
    this.setData({
      centerLat: bus.lat,
      centerLng: bus.lng
    });
  },

  onMarkerTap(event) {
    const markerId = event.detail.markerId;
    const busId = this.findBusIdByMarkerId(markerId);

    if (busId) {
      this.selectBus(busId);
    }
  },

  onCalloutTap(event) {
    const markerId = event.detail.markerId;
    const busId = this.findBusIdByMarkerId(markerId);

    if (busId) {
      this.selectBus(busId);
    }
  },

  onBusRowTap(event) {
    const busId = event.currentTarget.dataset.busId;
    const bus = this.busStore[busId];

    if (!bus) {
      return;
    }

    this.selectBus(busId);
    this.followBus(bus);
  },

  selectBus(busId) {
    this.selectedBusId = busId;
    this.refreshBusList();
    this.refreshAllMarkers();

    if (this.calloutTimer) {
      clearTimeout(this.calloutTimer);
    }

    this.calloutTimer = setTimeout(() => {
      this.selectedBusId = '';
      this.refreshBusList();
      this.refreshAllMarkers();
    }, CALLOUT_AUTO_HIDE_DURATION);
  },

  findBusIdByMarkerId(markerId) {
    return Object.keys(BUS_META).find((busId) => BUS_META[busId].markerId === markerId);
  },

  getCalloutText(bus) {
    return `${bus.bus_id}\n速度：${Math.round(Number(bus.speed || 0))} km/h\n更新：${this.formatTime(bus.timestamp)}`;
  },

  getBearing(from, to) {
    const lat1 = this.toRad(from.lat);
    const lat2 = this.toRad(to.lat);
    const lngDelta = this.toRad(to.lng - from.lng);
    const y = Math.sin(lngDelta) * Math.cos(lat2);
    const x =
      Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(lngDelta);
    const bearing = (this.toDeg(Math.atan2(y, x)) + 360) % 360;

    return Number.isFinite(bearing) ? bearing : Number(from.rotation || 0);
  },

  isLongJump(from, to) {
    const distance = this.getDistanceMeters(from.lat, from.lng, to.lat, to.lng);
    return distance > 900;
  },

  getDistanceMeters(lat1, lng1, lat2, lng2) {
    const earthRadius = 6371000;
    const dLat = this.toRad(lat2 - lat1);
    const dLng = this.toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) *
        Math.cos(this.toRad(lat2)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return earthRadius * c;
  },

  toRad(deg) {
    return (Number(deg) * Math.PI) / 180;
  },

  toDeg(rad) {
    return (Number(rad) * 180) / Math.PI;
  },

  formatTime(timestamp) {
    const ms = timestamp > 1000000000000 ? timestamp : timestamp * 1000;
    const date = new Date(ms);
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    const second = String(date.getSeconds()).padStart(2, '0');

    return `${hour}:${minute}:${second}`;
  }
});
