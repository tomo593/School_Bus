App({
  globalData: {
    // 未来真实后端接口预留：GET /api/bus/list
    apiBaseUrl: 'http://127.0.0.1:8080',
    apiBusListPath: '/api/bus/list',

    // 未来真实公交 WebSocket 接口预留：WS /ws/bus
    wsUrl: 'ws://127.0.0.1:8080/ws/bus',

    // 开发期默认开启 mock。真实后端可用后，可在页面 connect 时关闭 enableMock。
    enableMock: true
  },

  onLaunch() {
    console.log('校园公交实时定位小程序启动');
  }
});
