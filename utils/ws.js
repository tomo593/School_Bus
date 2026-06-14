const DEFAULT_WS_URL = 'ws://127.0.0.1:8080/ws/bus';
const API_BUS_LIST = '/api/bus/list';
const RECONNECT_DELAY = 3000;
const HEARTBEAT_INTERVAL = 10000;
const MOCK_INTERVAL = 2000;

const MOCK_ROUTES = {
  BUS_01: [
    { lat: 33.123456, lng: 151.123456 },
    { lat: 33.123820, lng: 151.123880 },
    { lat: 33.124120, lng: 151.124480 },
    { lat: 33.123660, lng: 151.125060 },
    { lat: 33.122980, lng: 151.124580 },
    { lat: 33.122760, lng: 151.123760 }
  ],
  BUS_02: [
    { lat: 33.124056, lng: 151.122856 },
    { lat: 33.124520, lng: 151.123350 },
    { lat: 33.124350, lng: 151.124180 },
    { lat: 33.123720, lng: 151.124360 },
    { lat: 33.123260, lng: 151.123700 },
    { lat: 33.123480, lng: 151.122980 }
  ],
  BUS_03: [
    { lat: 33.122956, lng: 151.124156 },
    { lat: 33.123260, lng: 151.124740 },
    { lat: 33.122880, lng: 151.125180 },
    { lat: 33.122260, lng: 151.124760 },
    { lat: 33.122120, lng: 151.123940 },
    { lat: 33.122520, lng: 151.123520 }
  ]
};

class BusWebSocket {
  constructor() {
    this.url = DEFAULT_WS_URL;
    this.socketTask = null;
    this.connected = false;
    this.closedByUser = false;
    this.enableMock = true;
    this.listeners = [];

    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.mockTimer = null;
    this.connectionTimeoutTimer = null;

    this.mockBuses = this.createMockBuses();
  }

  connect(options = {}) {
    this.url = options.url || this.url || DEFAULT_WS_URL;
    this.enableMock = options.enableMock !== false;
    this.closedByUser = false;
    this.clearReconnectTimer();

    if (this.socketTask || this.connected) {
      return;
    }

    this.emit({
      type: 'socket_connecting',
      url: this.url
    });

    try {
      this.socketTask = wx.connectSocket({
        url: this.url,
        success: () => {},
        fail: (error) => {
          this.handleConnectFailed(error);
        }
      });

      this.bindSocketEvents(this.socketTask);
      this.connectionTimeoutTimer = setTimeout(() => {
        if (!this.connected && this.enableMock) {
          this.startMock();
        }
      }, 1800);
    } catch (error) {
      this.handleConnectFailed(error);
    }
  }

  onMessage(callback) {
    if (typeof callback !== 'function') {
      return () => {};
    }

    this.listeners.push(callback);

    return () => {
      this.listeners = this.listeners.filter((listener) => listener !== callback);
    };
  }

  send(data) {
    if (!this.connected || !this.socketTask) {
      return false;
    }

    const payload = typeof data === 'string' ? data : JSON.stringify(data);

    this.socketTask.send({
      data: payload,
      fail: (error) => {
        console.warn('WebSocket 发送失败', error);
      }
    });

    return true;
  }

  reconnect() {
    if (this.closedByUser) {
      return;
    }

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      if (!this.closedByUser && !this.connected) {
        this.socketTask = null;
        this.connect({
          url: this.url,
          enableMock: this.enableMock
        });
      }
    }, RECONNECT_DELAY);
  }

  close() {
    this.closedByUser = true;
    this.connected = false;
    this.clearReconnectTimer();
    this.clearConnectionTimeoutTimer();
    this.stopHeartbeat();
    this.stopMock();

    if (this.socketTask) {
      try {
        this.socketTask.close({
          code: 1000,
          reason: 'page close'
        });
      } catch (error) {
        console.warn('WebSocket 关闭异常', error);
      }
    }

    this.socketTask = null;
  }

  bindSocketEvents(socketTask) {
    socketTask.onOpen(() => {
      this.connected = true;
      this.clearConnectionTimeoutTimer();
      this.stopMock();
      this.startHeartbeat();
      this.emit({
        type: 'socket_open',
        url: this.url
      });
    });

    socketTask.onMessage((response) => {
      const message = this.parseMessage(response.data);

      if (!message) {
        return;
      }

      if (Array.isArray(message)) {
        message.forEach((item) => this.emit(item));
      } else {
        this.emit(message);
      }
    });

    socketTask.onError((error) => {
      this.emit({
        type: 'socket_error',
        error: error && error.errMsg ? error.errMsg : String(error)
      });

      this.connected = false;
      this.clearConnectionTimeoutTimer();
      this.stopHeartbeat();

      if (this.enableMock) {
        this.startMock();
      }

      this.reconnect();
    });

    socketTask.onClose(() => {
      this.connected = false;
      this.socketTask = null;
      this.clearConnectionTimeoutTimer();
      this.stopHeartbeat();

      if (!this.closedByUser) {
        this.emit({
          type: 'socket_close'
        });

        if (this.enableMock) {
          this.startMock();
        }

        this.reconnect();
      }
    });
  }

  handleConnectFailed(error) {
    this.connected = false;
    this.socketTask = null;
    this.clearConnectionTimeoutTimer();
    this.stopHeartbeat();
    this.emit({
      type: 'socket_error',
      error: error && error.errMsg ? error.errMsg : String(error || 'connect failed')
    });

    if (this.enableMock) {
      this.startMock();
    }

    this.reconnect();
  }

  startHeartbeat() {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      this.send({
        type: 'ping',
        timestamp: Date.now()
      });
    }, HEARTBEAT_INTERVAL);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  startMock() {
    if (!this.enableMock || this.mockTimer) {
      return;
    }

    this.emit({
      type: 'mock_start'
    });
    this.emitMockSnapshot(false);

    this.mockTimer = setInterval(() => {
      this.advanceMockBuses();
      this.emitMockSnapshot(false);
    }, MOCK_INTERVAL);
  }

  stopMock() {
    if (this.mockTimer) {
      clearInterval(this.mockTimer);
      this.mockTimer = null;
    }
  }

  emitMockSnapshot() {
    this.mockBuses.forEach((bus) => {
      this.emit({
        bus_id: bus.bus_id,
        lat: Number(bus.lat.toFixed(6)),
        lng: Number(bus.lng.toFixed(6)),
        speed: bus.speed,
        timestamp: Math.floor(Date.now() / 1000)
      });
    });
  }

  advanceMockBuses() {
    this.mockBuses = this.mockBuses.map((bus, index) => {
      const route = MOCK_ROUTES[bus.bus_id];
      const step = 0.22 - index * 0.025;
      let progress = bus.progress + step;
      let routeIndex = bus.routeIndex;

      while (progress >= 1) {
        progress -= 1;
        routeIndex = (routeIndex + 1) % route.length;
      }

      const from = route[routeIndex];
      const to = route[(routeIndex + 1) % route.length];
      const lat = from.lat + (to.lat - from.lat) * progress;
      const lng = from.lng + (to.lng - from.lng) * progress;

      // BUS_03 偶尔静止，便于展示“静止”状态。
      const paused = bus.bus_id === 'BUS_03' && Math.floor(Date.now() / 10000) % 4 === 0;
      const speed = paused ? 0 : Math.round(14 + index * 4 + Math.random() * 7);

      return {
        ...bus,
        routeIndex,
        progress,
        lat,
        lng,
        speed
      };
    });
  }

  createMockBuses() {
    return Object.keys(MOCK_ROUTES).map((busId, index) => {
      const firstPoint = MOCK_ROUTES[busId][0];

      return {
        bus_id: busId,
        lat: firstPoint.lat,
        lng: firstPoint.lng,
        speed: 0,
        routeIndex: 0,
        progress: index * 0.08
      };
    });
  }

  parseMessage(data) {
    if (!data) {
      return null;
    }

    if (typeof data === 'object') {
      return data;
    }

    try {
      const message = JSON.parse(data);

      if (message && message.type === 'pong') {
        return null;
      }

      if (message && message.type === 'bus_position' && message.data) {
        return message.data;
      }

      return message;
    } catch (error) {
      console.warn('WebSocket 消息解析失败', error, data);
      return null;
    }
  }

  emit(message) {
    this.listeners.forEach((listener) => {
      try {
        listener(message);
      } catch (error) {
        console.error('WebSocket 监听器执行失败', error);
      }
    });
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  clearConnectionTimeoutTimer() {
    if (this.connectionTimeoutTimer) {
      clearTimeout(this.connectionTimeoutTimer);
      this.connectionTimeoutTimer = null;
    }
  }
}

const wsClient = new BusWebSocket();

wsClient.DEFAULT_WS_URL = DEFAULT_WS_URL;
wsClient.API_BUS_LIST = API_BUS_LIST;

module.exports = wsClient;
