import {
  type Channel,
  isJsonRpcResponse,
  type JsonRequest,
  type JsonResponse,
} from "@slide-computer/signer";
import { PostMessageTransportError } from "./postMessageTransport";

export interface PostMessageChannelOptions {
  window: Window;
  origin: string;
}

export class PostMessageChannel implements Channel {
  constructor(private options: PostMessageChannelOptions) {}

  public get closed() {
    return this.options.window.closed;
  }

  public registerListener(
    listener: (response: JsonResponse) => Promise<void>,
  ): () => void {
    const messageListener = async (event: MessageEvent) => {
      if (
        event.source !== this.options.window ||
        event.origin !== this.options.origin ||
        !isJsonRpcResponse(event.data)
      ) {
        return;
      }
      await listener(event.data);
    };
    window.addEventListener("message", messageListener);
    return () => {
      window.removeEventListener("message", messageListener);
    };
  }

  public async send(request: JsonRequest): Promise<void> {
    if (this.options.window.closed) {
      throw new PostMessageTransportError("Communication channel is closed");
    }
    this.options.window.postMessage(request, this.options.origin);
  }

  public async close(): Promise<void> {
    this.options.window.close();
  }
}
