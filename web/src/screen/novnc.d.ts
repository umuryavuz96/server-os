// noVNC ships plain JS without types; RemoteScreen.vue types the few members it uses.
declare module "@novnc/novnc" {
  const RFB: new (target: HTMLElement, urlOrChannel: string | WebSocket, options?: Record<string, unknown>) => unknown;
  export default RFB;
}
