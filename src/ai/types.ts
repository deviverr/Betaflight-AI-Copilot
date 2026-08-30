/** Provider-agnostic chat types. Everything downstream speaks only these. */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string as emitted by the model; parsed by the agent loop. */
  arguments: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  /** Set on `tool` messages to link the result back to its call. */
  toolCallId?: string;
  name?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; finishReason: string }
  | { type: "error"; message: string };

export interface ModelInfo {
  id: string;
  label: string;
  /** Whether this model can call tools. Non-tool models get advisory mode only. */
  supportsTools: boolean;
  contextWindow?: number;
}

export interface AiProvider {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** True when the user must take an auth action before use. */
  readonly requiresLogin: boolean;
  isAvailable(): Promise<boolean>;
  isAuthenticated(): boolean;
  login(): Promise<void>;
  logout(): void;
  listModels(): Promise<ModelInfo[]>;
  chat(request: ChatRequest): AsyncGenerator<StreamEvent>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly providerId: string,
    readonly recoverable = true,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
