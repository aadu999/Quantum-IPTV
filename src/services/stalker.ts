import { fetchWithProxyFallback } from './proxy';

export class QuantumStalkerConnector {
  async fetchStalkerPortal(portalUrl: string, macAddress: string): Promise<boolean> {
    const cleanPortal = portalUrl.replace(/\/+$/, '');
    const handshakeUrl = `${cleanPortal}?type=stb&action=handshake&mac=${encodeURIComponent(macAddress)}`;
    try {
      await fetchWithProxyFallback(handshakeUrl);
      return true;
    } catch (e) {
      console.error('Stalker Connector Error:', e);
      throw e;
    }
  }
}

export const stalkerConnector = new QuantumStalkerConnector();
(window as any).stalkerConnector = stalkerConnector;
