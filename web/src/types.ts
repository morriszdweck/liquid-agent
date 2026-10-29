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
  port?: number;
  status: PartStatus;
  text?: string;
  fraction?: number;
  error?: string;
};

export type ApprovalMode = "askAlways" | "approveForMe" | "fullAuto";

export type Settings = {
  userName: string;
  personality: "friendly" | "concise" | "playful" | "professional";
  approvalMode: ApprovalMode;
  theme: "system" | "light" | "dark";
  voice: "female" | "male";
  speakReplies: boolean;
  workspace: string;
  guardianThreshold: number;
  contextBudget: number;
  toolOutputLimit: number;
  maxSteps: number;
  temperature: number;
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

export type Snapshot = {
  chats: Chat[];
  running: string[];
  settings: Settings;
  parts: Part[];
  busy: boolean;
  memory: string[];
  ideas: { at: number; items: Idea[] };
  routines: Routine[];
  activity: ActivityEntry[];
  reminders: Reminder[];
  dataDir: string;
};
