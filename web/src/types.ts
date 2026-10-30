export type Attachment = { id: string; name: string; mime: string; kind: "image" | "audio" | "text" | "other"; size: number };

export type StepStatus = "pending" | "checking" | "approval" | "running" | "done" | "error" | "denied";

export type Step = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  label: string;
  note?: string;
  status: StepStatus;
  result?: string;
  decision?: string;
  reason?: string;
  pDeny?: number;
  at: number;
  ms?: number;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  at: number;
  attachments?: Attachment[];
  steps?: Step[];
  status?: "streaming" | "done" | "stopped" | "error";
  error?: string;
  model?: "small" | "omni";
  voice?: boolean;
  interrupted?: boolean;
  stats?: { ms: number; tokens: number; tps: number };
  thinking?: string;
  thinkingMs?: number;
};

export type Chat = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  named?: boolean;
  source?: "voice" | "routine";
  messages: Message[];
};

export type PartStatus = "missing" | "installing" | "installed" | "starting" | "running" | "failed";
export type Part = {
  id: "engine" | "small" | "omni" | "guardian" | "browser";
  title: string;
  detail: string;
  size: string;
  bytes: number;
  port?: number;
  status: PartStatus;
  text?: string;
  fraction?: number;
  error?: string;
  /** Waiting for another download to finish. */
  queued?: boolean;
  /** Still answering with its old size while a new size downloads. */
  live?: boolean;
  quant?: string;
  quants?: Quant[];
  /** Set on the Everyday brain when it was added from Hugging Face. */
  custom?: CustomModel;
};

export type Quant = { id: string; label: string; quant?: string; bytes: number; size: string; note?: string; onDisk?: boolean };

export type CustomVariant = Quant & { file: string; quant: string; shards: string[]; recommended?: boolean };

export type CustomModel = {
  repo: string;
  revision: string;
  label: string;
  license?: string | null;
  licenseUrl?: string | null;
  file: string;
  quant: string;
  bytes: number;
  meta?: { architecture?: string | null; contextLength?: number | null; hasTemplate?: boolean; thinking?: boolean; name?: string | null } | null;
};

export type ModelResolution = {
  repo: string;
  revision: string;
  label: string;
  license?: string | null;
  licenseUrl?: string | null;
  gated: boolean;
  variants: CustomVariant[];
  recommended: string;
  requested?: string | null;
  warning?: string;
};

export type ApprovalMode = "askAlways" | "approveForMe" | "fullAuto";

export type Settings = {
  userName: string;
  personality: "friendly" | "concise" | "playful" | "professional";
  approvalMode: ApprovalMode;
  theme: "system" | "light" | "dark";
  voice: "female" | "male";
  speakReplies: boolean;
  autoUpdate: boolean;
  workspace: string;
  guardianThreshold: number;
  contextBudget: number;
  toolOutputLimit: number;
  maxSteps: number;
  temperature: number;
  smallQuant: string;
  omniQuant: string;
  smallURL: string;
  omniURL: string;
  guardianURL: string;
  browserURL: string;
};

export type Idea = { title: string; prompt: string };

export type Routine = {
  id: string;
  name: string;
  icon: string;
  color: string;
  prompt: string;
  schedule: { enabled: boolean; time: string; days: number[] };
  lastRun: number;
  lastChatId?: string;
};

export type ActivityEntry = {
  id: string;
  at: number;
  chatId: string;
  tool: string;
  label: string;
  decision?: string;
  ok: boolean | null;
  pDeny?: number;
};

export type Reminder = { id: string; text: string; at: number };

/** Where this copy stands on updating itself. */
export type Update = {
  version: string;
  /** Release build number; null when running from a source checkout. */
  build: number | null;
  /** Whether this copy can replace itself. */
  managed: boolean;
  state: "idle" | "checking" | "downloading" | "ready" | "updating" | "error";
  /** The downloaded build waiting to go in. */
  ready: number | null;
  progress: number;
  error: string;
  checkedAt: number;
};

export type Snapshot = {
  chats: Chat[];
  running: string[];
  settings: Settings;
  parts: Part[];
  busy: boolean;
  guardianWanted: boolean;
  machine: { memoryGB: number };
  memory: string[];
  ideas: { at: number; items: Idea[] };
  routines: Routine[];
  activity: ActivityEntry[];
  reminders: Reminder[];
  dataDir: string;
  update: Update;
};
