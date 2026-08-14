import logger from "../lib/logger";
import messaging, { type Port, type Message } from "../messaging";
import { TypedEventTarget } from "../lib/TypedEventTarget";

import type { SenderMediaMessage, SenderMessage } from "../cast/sdk/types";
import type {
  ReceiverDevice,
  ReceiverSelectorAppInfo,
  ReceiverSelectorMediaType,
  ReceiverSelectorPageInfo,
} from "../types";

const POPUP_URL = browser.runtime.getURL("ui/popup/index.html");

export interface ReceiverSelection {
  device: ReceiverDevice;
  mediaType: ReceiverSelectorMediaType;
}

export interface ReceiverSelectorReceiverMessage {
  deviceId: string;
  message: SenderMessage;
}
export interface ReceiverSelectorMediaMessage {
  deviceId: string;
  message: SenderMediaMessage;
}

interface ReceiverSelectorEvents {
  selected: ReceiverSelection;
  cancelled: void;
  stop: { deviceId: string };
  error: string;
  close: void;
  receiverMessage: ReceiverSelectorReceiverMessage;
  mediaMessage: ReceiverSelectorMediaMessage;
}

/**
 * Manages the receiver selector popup window and communication with the
 * extension page hosted within.
 */
export default class ReceiverSelector extends TypedEventTarget<ReceiverSelectorEvents> {
  /** Whether a browser-action selector popup is being opened. */
  private opening = false;

  /** Message port to extension page. */
  private messagePort?: Port;
  private messagePortDisconnected?: boolean;
  private isClosing = false;

  private devices?: ReceiverDevice[];

  private defaultMediaType?: ReceiverSelectorMediaType;
  private availableMediaTypes?: ReceiverSelectorMediaType;

  /**
   * Transport IDs currently connected/owned by this browser. Cached so the very
   * first popup:update (sent when the popup connects) can tell the popup which
   * receiver is an owned session — this is what makes the Stop button appear
   * immediately, instead of only after a later device-change refresh.
   */
  private connectedTransportIds: string[] = [];

  private wasReceiverSelected = false;

  appInfo?: ReceiverSelectorAppInfo;
  pageInfo?: ReceiverSelectorPageInfo;

  constructor(
    private isBridgeCompatible: boolean,
    public readonly tabId: number
  ) {
    super();

    this.onConnect = this.onConnect.bind(this);
    this.onPopupMessage = this.onPopupMessage.bind(this);

    /**
     * Handle incoming message channel connection from popup
     * window script.
     */
    messaging.onConnect.addListener(this.onConnect);
  }

  /** Is receiver selector window currently open. */
  get isOpen() {
    return (
      this.opening || Boolean(this.messagePort && !this.messagePortDisconnected)
    );
  }

  /**
   * Creates and opens a receiver selector window.
   */
  public async open(opts: {
    devices: ReceiverDevice[];
    defaultMediaType: ReceiverSelectorMediaType;
    availableMediaTypes: ReceiverSelectorMediaType;
    appInfo?: ReceiverSelectorAppInfo;
    pageInfo?: ReceiverSelectorPageInfo;
    connectedTransportIds?: string[];
  }) {
    this.appInfo = opts.appInfo;
    this.pageInfo = opts.pageInfo;
    this.devices = opts.devices;
    this.defaultMediaType = opts.defaultMediaType;
    this.availableMediaTypes = opts.availableMediaTypes;
    this.connectedTransportIds = opts.connectedTransportIds ?? [];
    this.wasReceiverSelected = false;
    this.messagePortDisconnected = true;
    this.messagePort = undefined;
    this.opening = true;
    logger.info("Receiver selector ready in the open extension popup");
    void browser.runtime.sendMessage({
      subject: "receiverSelector:ready",
      data: { tabId: this.tabId },
    });
  }

  /** Updates receiver devices displayed in the receiver selector. */
  public update(
    devices: ReceiverDevice[],
    isBridgeCompatible: boolean,
    connectedTransportIds: string[]
  ) {
    this.devices = devices;
    this.connectedTransportIds = connectedTransportIds;
    if (!this.messagePort || this.messagePortDisconnected) return;
    try {
      this.messagePort.postMessage({
        subject: "popup:update",
        data: { devices, isBridgeCompatible, connectedTransportIds },
      });
    } catch (err) {
      this.messagePortDisconnected = true;
      this.messagePort = undefined;
      logger.error("Failed to update disconnected receiver popup", err);
    }
  }

  /** Closes the receiver selector (if open). */
  public async close() {
    if (this.isClosing) return;
    this.isClosing = true;
    this.opening = false;
    if (!this.wasReceiverSelected) {
      this.dispatchEvent(new CustomEvent("cancelled"));
    }
    if (this.messagePort && !this.messagePortDisconnected) {
      this.messagePort.disconnect();
    }
    messaging.onConnect.removeListener(this.onConnect);
    this.dispatchEvent(new CustomEvent("close"));
  }

  /**
   * Handles incoming port connection from the extension page and
   * sends init data.
   */
  private onConnect(port: Port) {
    if (port.name !== `popup:${this.tabId}`) {
      return;
    }

    this.messagePort?.disconnect();

    this.opening = false;
    this.messagePortDisconnected = false;
    this.messagePort = port;
    this.messagePort.onMessage.addListener(this.onPopupMessage);
    const connectedPort = this.messagePort;
    this.messagePort.onDisconnect.addListener(() => {
      if (this.messagePort !== connectedPort) return;
      this.messagePortDisconnected = true;
      this.messagePort = undefined;
      this.opening = false;
      messaging.onConnect.removeListener(this.onConnect);
      if (this.isClosing) return;
      this.isClosing = true;
      if (!this.wasReceiverSelected) {
        this.dispatchEvent(new CustomEvent("cancelled"));
      }
      this.dispatchEvent(new CustomEvent("close"));
    });

    if (
      this.devices === undefined ||
      this.defaultMediaType === undefined ||
      this.availableMediaTypes === undefined
    ) {
      this.dispatchEvent(
        new CustomEvent("error", {
          detail: "Popup receiver data not found.",
        })
      );
      return;
    }

    this.messagePort.postMessage({
      subject: "popup:init",
      data: {
        tabId: this.tabId,
        appInfo: this.appInfo,
        pageInfo: this.pageInfo,
        devices: this.devices,
        isBridgeCompatible: this.isBridgeCompatible,
        defaultMediaType: this.defaultMediaType,
        availableMediaTypes: this.availableMediaTypes,
        connectedTransportIds: this.connectedTransportIds,
      },
    });
  }

  /** Handles messages from the popup extension page. */
  private onPopupMessage(message: Message) {
    switch (message.subject) {
      case "main:receiverSelected":
        // The selector's selected event resolves a one-shot Promise. Ignore a
        // second selection from the same long-lived popup; Stop -> Cast must
        // create a fresh current-tab request instead.
        if (this.wasReceiverSelected) {
          logger.info("Ignoring selection on consumed receiver selector", {
            deviceId: message.data.device.id,
            mediaType: message.data.mediaType,
          });
          break;
        }
        this.wasReceiverSelected = true;
        this.dispatchEvent(
          new CustomEvent("selected", { detail: message.data })
        );
        break;

      case "main:receiverStopped":
        this.dispatchEvent(new CustomEvent("stop", { detail: message.data }));
        break;

      case "main:sendReceiverMessage":
        this.dispatchEvent(
          new CustomEvent("receiverMessage", { detail: message.data })
        );
        break;
      case "main:sendMediaMessage":
        this.dispatchEvent(
          new CustomEvent("mediaMessage", { detail: message.data })
        );
        break;
    }
  }
}
