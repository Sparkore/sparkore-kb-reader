import {
  App,
  FuzzySuggestModal,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SettingDefinitionItem,
  SettingGroupItem,
  TFile,
  normalizePath,
  requestUrl,
} from "obsidian";

const BUILT_IN_GITHUB_APP_CLIENT_ID = "Iv23lirlrKVZLobrsmYi";
const BUILT_IN_GITHUB_APP_INSTALL_URL = "https://github.com/apps/sparkore-kb-reader/installations/new";
const ACCESS_TOKEN_SECRET = "sparkore-kb-reader-access-token";
const REFRESH_TOKEN_SECRET = "sparkore-kb-reader-refresh-token";

type DestinationMode = "vault-root" | "custom";
type SyncStatus = "never" | "syncing" | "success" | "error";

interface ReaderProject {
  id: string;
  repository: string;
  branch: string;
  kbRoot: string;
  destinationMode: DestinationMode;
  localFolder: string;
  lastSyncStatus: SyncStatus;
  lastSyncMessage: string;
  lastSyncedAt: string;
}

interface SyncedFileState {
  sha: string;
}

interface ProjectSyncState {
  resolvedBranch?: string;
  resolvedRoot?: string;
  files: Record<string, SyncedFileState>;
}

interface ReaderSettings {
  githubLogin: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  syncOnStartup: boolean;
  pruneDeleted: boolean;
  projects: ReaderProject[];
  syncState: Record<string, ProjectSyncState>;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

const DEFAULT_SETTINGS: ReaderSettings = {
  githubLogin: "",
  accessExpiresAt: 0,
  refreshExpiresAt: 0,
  syncOnStartup: false,
  pruneDeleted: true,
  projects: [],
  syncState: {},
};

type GitHubContentItem = {
  type: "file" | "dir";
  path: string;
  name: string;
  sha: string;
  url: string;
};

type GitHubFileContent = {
  content: string;
  encoding: string;
};

function projectId(): string {
  return crypto.randomUUID();
}

function normalizedRepo(value: string): string {
  return value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
}


function normalizedPathKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) matrix[i][0] = i;
  for (let j = 0; j < cols; j += 1) matrix[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[a.length][b.length];
}

function shouldSkipRemoteRelativePath(relative: string): boolean {
  const normalized = relative.replace(/\\/g, "/").replace(/^\/+/, "");
  return (
    normalized === ".obsidian" ||
    normalized.startsWith(".obsidian/") ||
    normalized === ".git" ||
    normalized.startsWith(".git/") ||
    normalized === ".trash" ||
    normalized.startsWith(".trash/")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}


class StringPickerModal extends FuzzySuggestModal<string> {
  private readonly items: string[];
  private readonly choose: (item: string) => void;

  constructor(app: App, items: string[], placeholder: string, choose: (item: string) => void) {
    super(app);
    this.items = items;
    this.choose = choose;
    this.setPlaceholder(placeholder);
  }

  getItems(): string[] {
    return this.items;
  }

  getItemText(item: string): string {
    return item;
  }

  onChooseItem(item: string): void {
    this.choose(item);
  }
}

class RemoteFolderBrowserModal extends Modal {
  private currentPath = "";

  constructor(
    app: App,
    private readonly plugin: SparkoreKbReader,
    private readonly repository: string,
    private readonly branch: string,
    private readonly choose: (path: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    void this.render();
  }

  private async render(): Promise<void> {
    this.contentEl.empty();
    this.setTitle("Choose KB root");

    new Setting(this.contentEl)
      .setName(this.currentPath || "Repository root")
      .setDesc(this.currentPath ? "Current GitHub folder" : "Browse folders in the selected repository.")
      .addButton((button) => button
        .setButtonText("Use folder")
        .setDisabled(!this.currentPath)
        .onClick(() => {
          if (!this.currentPath) return;
          this.choose(this.currentPath);
          this.close();
        }));

    if (this.currentPath) {
      new Setting(this.contentEl)
        .setName("..")
        .setDesc("Go to parent folder")
        .addButton((button) => button
          .setButtonText("Up")
          .onClick(() => {
            const parts = this.currentPath.split("/").filter(Boolean);
            parts.pop();
            this.currentPath = parts.join("/");
            void this.render();
          }));
    }

    try {
      const folders = await this.plugin.listRemoteFolders(this.repository, this.branch, this.currentPath);
      if (folders.length === 0) {
        this.contentEl.createEl("p", { text: "No subfolders here." });
        return;
      }

      for (const folder of folders) {
        new Setting(this.contentEl)
          .setName(folder.name)
          .setDesc(folder.path)
          .addButton((button) => button
            .setButtonText("Open")
            .onClick(() => {
              this.currentPath = folder.path;
              void this.render();
            }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.contentEl.createEl("p", { text: `Could not load folders: ${message}` });
    }
  }
}

export default class SparkoreKbReader extends Plugin {
  settings: ReaderSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addRibbonIcon("refresh-cw", "Refresh Sparkore knowledge bases", () => {
      void this.syncAll();
    });

    this.addCommand({
      id: "refresh-all",
      name: "Refresh all knowledge bases",
      callback: () => void this.syncAll(),
    });

    this.addCommand({
      id: "connect-github",
      name: "Connect GitHub",
      callback: () => void this.connectGitHub(),
    });

    this.addSettingTab(new SparkoreKbReaderSettingTab(this.app, this));

    if (this.settings.syncOnStartup) {
      this.app.workspace.onLayoutReady(() => {
        void this.syncAll();
      });
    }
  }

  async loadSettings(): Promise<void> {
    const saved = await this.loadData() as Partial<ReaderSettings> | null;
    const projects: ReaderProject[] = (saved?.projects ?? []).map((project) => ({
      id: project.id || projectId(),
      repository: project.repository ?? "",
      branch: project.branch ?? "",
      kbRoot: project.kbRoot ?? "",
      destinationMode: project.destinationMode === "custom" && project.localFolder ? "custom" : "vault-root",
      localFolder: project.localFolder ?? "",
      lastSyncStatus: project.lastSyncStatus ?? "never",
      lastSyncMessage: project.lastSyncMessage ?? "",
      lastSyncedAt: project.lastSyncedAt ?? "",
    }));

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(saved ?? {}),
      projects,
      syncState: saved?.syncState ?? {},
    };

    if (projects.some((project, index) => project.id !== saved?.projects?.[index]?.id)) {
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  getClientId(): string {
    return BUILT_IN_GITHUB_APP_CLIENT_ID;
  }

  private async oauthPost<T>(body: URLSearchParams): Promise<T> {
    const response = await requestUrl({
      url: body.has("device_code")
        ? "https://github.com/login/oauth/access_token"
        : "https://github.com/login/device/code",
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`GitHub OAuth request failed (${response.status}).`);
    }
    return response.json as T;
  }

  private async refreshAccessToken(clientId: string, refreshToken: string): Promise<string | null> {
    const response = await requestUrl({
      url: "https://github.com/login/oauth/access_token",
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) return null;
    const token = response.json as TokenResponse;
    if (!token.access_token || token.error) return null;

    this.storeTokens(token);
    await this.saveSettings();
    return token.access_token;
  }

  private storeTokens(token: TokenResponse): void {
    if (token.access_token) {
      this.app.secretStorage.setSecret(ACCESS_TOKEN_SECRET, token.access_token);
    }
    if (token.refresh_token) {
      this.app.secretStorage.setSecret(REFRESH_TOKEN_SECRET, token.refresh_token);
    }

    const now = Date.now();
    this.settings.accessExpiresAt = token.expires_in ? now + token.expires_in * 1000 : 0;
    this.settings.refreshExpiresAt = token.refresh_token_expires_in
      ? now + token.refresh_token_expires_in * 1000
      : 0;
  }

  private async getToken(): Promise<string | null> {
    const access = this.app.secretStorage.getSecret(ACCESS_TOKEN_SECRET);
    if (!access) return null;

    if (!this.settings.accessExpiresAt || this.settings.accessExpiresAt > Date.now() + 60_000) {
      return access;
    }

    const refresh = this.app.secretStorage.getSecret(REFRESH_TOKEN_SECRET);
    const clientId = this.getClientId();
    if (!refresh || !clientId || (this.settings.refreshExpiresAt && this.settings.refreshExpiresAt <= Date.now())) {
      return null;
    }

    return await this.refreshAccessToken(clientId, refresh);
  }

  async connectGitHub(): Promise<void> {
    const clientId = this.getClientId();
    if (!clientId) {
      new Notice("Sparkore KB Reader: GitHub App client ID is not configured in this build.", 10000);
      return;
    }

    try {
      const device = await this.oauthPost<DeviceCodeResponse>(new URLSearchParams({
        client_id: clientId,
      }));

      try {
        await navigator.clipboard.writeText(device.user_code);
      } catch {
        // Clipboard can be unavailable on some mobile hosts; the code is also shown in the notice.
      }

      window.open(device.verification_uri, "_blank");
      new Notice(
        `GitHub code ${device.user_code} copied. Authorize Sparkore KB Reader in the browser; this screen will finish automatically.`,
        15000,
      );

      let interval = Math.max(device.interval, 5);
      const deadline = Date.now() + device.expires_in * 1000;

      while (Date.now() < deadline) {
        await sleep(interval * 1000);

        const token = await this.oauthPost<TokenResponse>(new URLSearchParams({
          client_id: clientId,
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }));

        if (token.access_token) {
          this.storeTokens(token);
          const user = await this.github<{ login: string }>("https://api.github.com/user", token.access_token);
          this.settings.githubLogin = user.login;
          await this.saveSettings();
          new Notice(`Sparkore KB Reader: connected to GitHub as @${user.login}.`);
          return;
        }

        if (token.error === "authorization_pending") continue;
        if (token.error === "slow_down") {
          interval += 5;
          continue;
        }
        if (token.error === "access_denied") {
          throw new Error("GitHub authorization was cancelled.");
        }
        if (token.error === "expired_token") {
          throw new Error("GitHub authorization code expired. Try Connect GitHub again.");
        }
        throw new Error(token.error_description || token.error || "GitHub authorization failed.");
      }

      throw new Error("GitHub authorization timed out. Try Connect GitHub again.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Sparkore KB Reader: ${message}`, 10000);
    }
  }

  async disconnectGitHub(): Promise<void> {
    this.app.secretStorage.setSecret(ACCESS_TOKEN_SECRET, "");
    this.app.secretStorage.setSecret(REFRESH_TOKEN_SECRET, "");
    this.settings.githubLogin = "";
    this.settings.accessExpiresAt = 0;
    this.settings.refreshExpiresAt = 0;
    await this.saveSettings();
    new Notice("Sparkore KB Reader: GitHub disconnected.");
  }

  private async github<T>(url: string, token?: string | null): Promise<T> {
    const resolvedToken = token === undefined ? await this.getToken() : token;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (resolvedToken) headers.Authorization = `Bearer ${resolvedToken}`;

    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await requestUrl({
          url,
          method: "GET",
          headers,
          throw: false,
        });

        if (response.status < 200 || response.status >= 300) {
          const hint = response.status === 404 && !resolvedToken
            ? " Connect GitHub for private repositories."
            : response.status === 404
              ? " Check that the Sparkore GitHub App is installed for this repository and that the branch/path exists."
              : "";
          throw new Error(`GitHub request failed (${response.status}).${hint}`);
        }
        return response.json as T;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        const transient = /unknownhostexception|unable to resolve host|no address associated with hostname|network|timed? ?out|connection reset/i.test(message);
        if (!transient || attempt === 3) {
          if (transient) {
            throw new Error("Cannot reach api.github.com. Check internet connection, VPN or Private DNS, then try again.");
          }
          throw error;
        }
        await sleep(500 * attempt);
      }
    }
    throw lastError;
  }

  private apiPath(repository: string, path: string, branch: string): string {
    const encodedPath = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    const suffix = encodedPath ? `/${encodedPath}` : "";
    return `https://api.github.com/repos/${repository}/contents${suffix}?ref=${encodeURIComponent(branch)}`;
  }

  private async resolveBranch(project: ReaderProject): Promise<string> {
    const configured = project.branch.trim();
    if (configured) return configured;

    const repo = await this.github<{ default_branch: string }>(
      `https://api.github.com/repos/${project.repository}`,
    );
    return repo.default_branch;
  }

  async listRepositories(): Promise<string[]> {
    const token = await this.getToken();
    if (!token) {
      throw new Error("Connect GitHub first to browse repositories.");
    }

    const repositories: string[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const items = await this.github<Array<{ full_name: string }>>(
        `https://api.github.com/user/repos?per_page=100&page=${page}&sort=full_name`,
        token,
      );
      repositories.push(...items.map((item) => item.full_name));
      if (items.length < 100) break;
    }
    return [...new Set(repositories)].sort((a, b) => a.localeCompare(b));
  }

  async listBranches(repository: string): Promise<string[]> {
    const normalized = normalizedRepo(repository);
    if (normalized.split("/").length !== 2) {
      throw new Error("Choose a repository first.");
    }

    const branches: string[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const items = await this.github<Array<{ name: string }>>(
        `https://api.github.com/repos/${normalized}/branches?per_page=100&page=${page}`,
      );
      branches.push(...items.map((item) => item.name));
      if (items.length < 100) break;
    }
    return branches;
  }

  async listRemoteFolders(
    repository: string,
    branch: string,
    path: string,
  ): Promise<Array<{ name: string; path: string }>> {
    const items = await this.github<GitHubContentItem[]>(
      this.apiPath(normalizedRepo(repository), path, branch),
    );
    return items
      .filter((item) => item.type === "dir")
      .map((item) => ({ name: item.name, path: item.path }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async resolvedBranch(project: ReaderProject): Promise<string> {
    return await this.resolveBranch({ ...project, repository: normalizedRepo(project.repository) });
  }

  private decodeBase64Bytes(content: string): Uint8Array {
    const binary = atob(content.replace(/\n/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  private async suggestKbRoot(repository: string, branch: string, requested: string): Promise<string | null> {
    try {
      const roots = await this.listRemoteFolders(repository, branch, "");
      if (roots.length === 0) return null;
      const target = normalizedPathKey(requested);
      const ranked = roots
        .map((folder) => ({
          path: folder.path,
          score: editDistance(target, normalizedPathKey(folder.path)),
        }))
        .sort((a, b) => a.score - b.score);
      const best = ranked[0];
      if (!best) return null;
      const threshold = Math.max(2, Math.floor(target.length * 0.35));
      return best.score <= threshold ? best.path : null;
    } catch {
      return null;
    }
  }

  private async listRecursive(
    repository: string,
    branch: string,
    path: string,
  ): Promise<GitHubContentItem[]> {
    let items: GitHubContentItem[];
    try {
      items = await this.github<GitHubContentItem[]>(this.apiPath(repository, path, branch));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("(404)")) {
        const suggestion = await this.suggestKbRoot(repository, branch, path);
        const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
        throw new Error(`KB path "${path}" was not found on ${repository}@${branch}.${hint} Use Browse to select an existing folder.`);
      }
      throw error;
    }
    const result: GitHubContentItem[] = [];

    for (const item of items) {
      if (item.type === "file") {
        result.push(item);
      } else if (item.type === "dir") {
        result.push(...await this.listRecursive(repository, branch, item.path));
      }
    }
    return result;
  }

  private async ensureFolder(folder: string): Promise<void> {
    const normalized = normalizePath(folder);
    if (!normalized) return;

    const parts = normalized.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;

      if (await this.app.vault.adapter.exists(current)) {
        continue;
      }

      try {
        await this.app.vault.createFolder(current);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const alreadyExists = /already exists|eexist/i.test(message);
        if (alreadyExists || await this.app.vault.adapter.exists(current)) {
          continue;
        }
        throw error;
      }
    }
  }

  private async writeBinary(path: string, bytes: Uint8Array): Promise<void> {
    const normalized = normalizePath(path);
    const slash = normalized.lastIndexOf("/");
    if (slash >= 0) await this.ensureFolder(normalized.slice(0, slash));

    const existing = this.app.vault.getAbstractFileByPath(normalized);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, buffer);
      return;
    }
    if (!existing) {
      await this.app.vault.createBinary(normalized, buffer);
      return;
    }
    throw new Error(`Cannot replace non-file path: ${normalized}`);
  }

  private async fetchFile(item: GitHubContentItem): Promise<Uint8Array> {
    const raw = await this.github<GitHubFileContent>(item.url);
    if (raw.encoding !== "base64") {
      throw new Error(`Unsupported GitHub content encoding for ${item.path}.`);
    }
    return this.decodeBase64Bytes(raw.content);
  }

  private validateProject(project: ReaderProject): void {
    const repository = normalizedRepo(project.repository);
    if (repository.split("/").length !== 2) {
      throw new Error("Repository must use owner/name format.");
    }
    if (!project.kbRoot.trim()) {
      throw new Error("KB root is not selected. Use Browse to choose the knowledge-base folder.");
    }
  }

  private destinationRoot(project: ReaderProject): string {
    if (project.destinationMode === "vault-root") return "";
    if (project.destinationMode === "custom" && project.localFolder.trim()) {
      return normalizePath(project.localFolder.trim());
    }
    return "";
  }

  destinationLabel(project: ReaderProject): string {
    if (project.destinationMode === "vault-root") return "Current vault root";
    if (project.destinationMode === "custom" && project.localFolder.trim()) return project.localFolder.trim();
    return "Current vault root";
  }

  syncStatusText(project: ReaderProject): string {
    if (project.lastSyncStatus === "syncing") return "Syncing from GitHub…";
    if (project.lastSyncStatus === "success") {
      const when = project.lastSyncedAt ? new Date(project.lastSyncedAt).toLocaleString() : "recently";
      return `Last sync succeeded ${when}. ${project.lastSyncMessage}`;
    }
    if (project.lastSyncStatus === "error") return `Last sync failed: ${project.lastSyncMessage}`;
    return "Not synced yet.";
  }

  async syncProjectWithFeedback(project: ReaderProject): Promise<void> {
    const projectName = normalizedRepo(project.repository).split("/").pop() || "project";
    project.lastSyncStatus = "syncing";
    project.lastSyncMessage = "";
    await this.saveSettings();
    new Notice(`Sparkore KB Reader: syncing ${projectName}…`);

    try {
      const result = await this.syncProject(project);
      project.lastSyncStatus = "success";
      project.lastSyncedAt = new Date().toISOString();
      project.lastSyncMessage = `${result.updated} updated · ${result.unchanged} unchanged · ${result.removed} removed`;
      await this.saveSettings();
      new Notice(`Sparkore KB Reader: ${projectName} synced successfully.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      project.lastSyncStatus = "error";
      project.lastSyncMessage = message;
      await this.saveSettings();
      new Notice(`Sparkore KB Reader: ${message}`, 12000);
    }
  }

  async syncProject(project: ReaderProject): Promise<{ updated: number; unchanged: number; removed: number }> {
    this.validateProject(project);

    const repository = normalizedRepo(project.repository);
    const branch = await this.resolveBranch({ ...project, repository });
    const kbRoot = project.kbRoot.trim().replace(/^\/+|\/+$/g, "");
    const localRoot = this.destinationRoot(project);

    const allFiles = await this.listRecursive(repository, branch, kbRoot);
    const files = allFiles.filter((item) => {
      const relative = item.path.startsWith(`${kbRoot}/`)
        ? item.path.slice(kbRoot.length + 1)
        : item.name;
      return !shouldSkipRemoteRelativePath(relative);
    });
    const state = this.settings.syncState[project.id] ?? { files: {} };
    const nextFiles: Record<string, SyncedFileState> = {};
    let downloaded = 0;
    let unchanged = 0;

    for (const item of files) {
      const relative = item.path.startsWith(`${kbRoot}/`)
        ? item.path.slice(kbRoot.length + 1)
        : item.name;
      const localPath = normalizePath(localRoot ? `${localRoot}/${relative}` : relative);
      const local = this.app.vault.getAbstractFileByPath(localPath);
      const previous = state.files[relative];

      if (local instanceof TFile && previous?.sha === item.sha) {
        nextFiles[relative] = previous;
        unchanged += 1;
        continue;
      }

      const bytes = await this.fetchFile(item);
      await this.writeBinary(localPath, bytes);
      nextFiles[relative] = { sha: item.sha };
      downloaded += 1;
    }

    let removed = 0;
    if (this.settings.pruneDeleted) {
      for (const oldRelative of Object.keys(state.files)) {
        if (nextFiles[oldRelative]) continue;
        const oldPath = normalizePath(localRoot ? `${localRoot}/${oldRelative}` : oldRelative);
        const oldFile = this.app.vault.getAbstractFileByPath(oldPath);
        if (oldFile instanceof TFile) {
          await this.app.fileManager.trashFile(oldFile);
          removed += 1;
        }
      }
    }

    this.settings.syncState[project.id] = {
      resolvedBranch: branch,
      resolvedRoot: kbRoot,
      files: nextFiles,
    };
    await this.saveSettings();

    return { updated: downloaded, unchanged, removed };
  }

  async syncAll(): Promise<void> {
    if (this.settings.projects.length === 0) {
      new Notice("Sparkore KB Reader: add a project in settings first.");
      return;
    }

    for (const project of this.settings.projects) {
      await this.syncProjectWithFeedback(project);
    }
  }

  async removeProject(index: number): Promise<void> {
    const project = this.settings.projects[index];
    if (!project) return;
    delete this.settings.syncState[project.id];
    this.settings.projects.splice(index, 1);
    await this.saveSettings();
  }
}

class SparkoreKbReaderSettingTab extends PluginSettingTab {
  plugin: SparkoreKbReader;

  constructor(app: App, plugin: SparkoreKbReader) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const githubItems: SettingGroupItem[] = [];

    if (this.plugin.settings.githubLogin) {
      githubItems.push({
        name: `Connected as @${this.plugin.settings.githubLogin}`,
        desc: "Authentication uses the Sparkore GitHub App. OAuth tokens are stored in Obsidian SecretStorage.",
        render: (setting: Setting) => {
          setting.addButton((button) => button
            .setDestructive()
            .setButtonText("Disconnect")
            .onClick(async () => {
              await this.plugin.disconnectGitHub();
              this.update();
            }));
        },
      });
    } else {
      githubItems.push({
        name: "Connect GitHub",
        desc: "Authorize in your browser using GitHub Device Flow. No personal access token is required.",
        render: (setting: Setting) => {
          setting.addButton((button) => button
            .setCta()
            .setButtonText("Connect GitHub")
            .onClick(async () => {
              await this.plugin.connectGitHub();
              this.update();
            }));
        },
      });
    }

    if (BUILT_IN_GITHUB_APP_INSTALL_URL) {
      githubItems.push({
        name: "Repository access",
        desc: "Install or manage Sparkore KB Reader access for the GitHub repositories you want to read.",
        action: () => {
          window.open(BUILT_IN_GITHUB_APP_INSTALL_URL, "_blank");
        },
      });
    }

    const projectPages: SettingGroupItem[] = this.plugin.settings.projects.map((project, index) => ({
      type: "page",
      name: project.repository || `Project ${index + 1}`,
      desc: `${project.branch || "Default branch"} · ${project.kbRoot || "Choose KB root"}`,
      items: [
        {
          name: "Sync status",
          desc: this.plugin.syncStatusText(project),
          render: (setting: Setting) => {
            setting.addButton((button) => button
              .setCta()
              .setButtonText(project.lastSyncStatus === "syncing" ? "Syncing…" : "Sync now")
              .setDisabled(project.lastSyncStatus === "syncing")
              .onClick(async () => {
                await this.plugin.syncProjectWithFeedback(project);
                this.update();
              }));
          },
        },
        {
          name: "Repository",
          desc: "Choose from repositories available to the connected GitHub App. Manual entry remains available as a fallback.",
          render: (setting: Setting) => {
            setting.addText((text) => text
              .setValue(project.repository)
              .setPlaceholder("owner/repo")
              .onChange(async (value) => {
                project.repository = normalizedRepo(value);
                await this.plugin.saveSettings();
              }));
            setting.addButton((button) => button
              .setButtonText("Choose")
              .onClick(async () => {
                try {
                  const repositories = await this.plugin.listRepositories();
                  if (repositories.length === 0) {
                    new Notice("Sparkore KB Reader: no accessible repositories found.");
                    return;
                  }
                  new StringPickerModal(this.app, repositories, "Choose a GitHub repository", (repository) => {
                    project.repository = repository;
                    project.branch = "";
                    project.kbRoot = "";
                    project.lastSyncStatus = "never";
                    project.lastSyncMessage = "";
                    project.lastSyncedAt = "";
                    void this.plugin.saveSettings().then(() => this.update());
                  }).open();
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  new Notice(`Sparkore KB Reader: ${message}`, 10000);
                }
              }));
          },
        },
        {
          name: "Branch",
          desc: "Choose a branch from GitHub. Leave empty to follow the repository default branch.",
          render: (setting: Setting) => {
            setting.addText((text) => text
              .setValue(project.branch)
              .setPlaceholder("Default branch")
              .onChange(async (value) => {
                project.branch = value.trim();
                await this.plugin.saveSettings();
              }));
            setting.addButton((button) => button
              .setButtonText("Choose")
              .onClick(async () => {
                try {
                  const branches = await this.plugin.listBranches(project.repository);
                  const defaultLabel = "(Use repository default branch)";
                  new StringPickerModal(this.app, [defaultLabel, ...branches], "Choose a branch", (branch) => {
                    project.branch = branch === defaultLabel ? "" : branch;
                    void this.plugin.saveSettings().then(() => this.update());
                  }).open();
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  new Notice(`Sparkore KB Reader: ${message}`, 10000);
                }
              }));
          },
        },
        {
          name: "KB root",
          desc: "Browse GitHub folders or enter a path manually.",
          render: (setting: Setting) => {
            setting.addText((text) => text
              .setValue(project.kbRoot)
              .setPlaceholder("Choose or browse a folder")
              .onChange(async (value) => {
                project.kbRoot = value.trim();
                project.lastSyncStatus = "never";
                await this.plugin.saveSettings();
              }));
            setting.addButton((button) => button
              .setButtonText("Browse")
              .onClick(async () => {
                try {
                  if (!project.repository) throw new Error("Choose a repository first.");
                  const branch = await this.plugin.resolvedBranch(project);
                  new RemoteFolderBrowserModal(
                    this.app,
                    this.plugin,
                    normalizedRepo(project.repository),
                    branch,
                    (path) => {
                      project.kbRoot = path;
                      project.lastSyncStatus = "never";
                      void this.plugin.saveSettings().then(() => this.update());
                    },
                  ).open();
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  new Notice(`Sparkore KB Reader: ${message}`, 10000);
                }
              }));
          },
        },
        {
          name: "Vault destination",
          desc: "KB Reader writes inside the currently opened Obsidian vault on mobile. Source metadata folders such as .obsidian, .git, and .trash are never copied. The default is the current vault root; you may optionally choose an existing folder inside this vault.",
          render: (setting: Setting) => {
            setting.addText((text) => text
              .setValue(this.plugin.destinationLabel(project))
              .setDisabled(true));
            setting.addButton((button) => button
              .setButtonText("Choose")
              .onClick(() => {
                const vaultRoot = "Current vault root";
                const folders = this.app.vault
                  .getAllFolders(true)
                  .map((folder) => folder.path)
                  .filter((path) => path && path !== "/")
                  .sort((a, b) => a.localeCompare(b));
                new StringPickerModal(this.app, [vaultRoot, ...folders], "Choose destination inside this vault", (folder) => {
                  if (folder === vaultRoot) {
                    project.destinationMode = "vault-root";
                    project.localFolder = "";
                  } else {
                    project.destinationMode = "custom";
                    project.localFolder = folder;
                  }
                  project.lastSyncStatus = "never";
                  void this.plugin.saveSettings().then(() => this.update());
                }).open();
              }));
          },
        },
      ],
    }));

    return [
      {
        type: "group",
        heading: "GitHub",
        items: githubItems,
      },
      {
        type: "group",
        heading: "Sync",
        items: [
          {
            name: "Refresh on startup",
            desc: "Refresh configured knowledge bases after the workspace is ready.",
            control: {
              type: "toggle",
              key: "syncOnStartup",
            },
          },
          {
            name: "Remove files deleted upstream",
            desc: "Move Reader-managed files to Obsidian trash when they no longer exist in the selected GitHub path.",
            control: {
              type: "toggle",
              key: "pruneDeleted",
            },
          },
        ],
      },
      {
        type: "list",
        heading: "Projects",
        emptyState: "No knowledge bases configured yet.",
        items: projectPages,
        addItem: {
          name: "Add project",
          action: () => {
            this.plugin.settings.projects.push({
              id: projectId(),
              repository: "",
              branch: "",
              kbRoot: "",
              destinationMode: "vault-root",
              localFolder: "",
              lastSyncStatus: "never",
              lastSyncMessage: "",
              lastSyncedAt: "",
            });
            void this.plugin.saveSettings().then(() => this.update());
          },
        },
        onReorder: (oldIndex: number, newIndex: number) => {
          const projects = this.plugin.settings.projects;
          const [moved] = projects.splice(oldIndex, 1);
          if (!moved) return;
          projects.splice(newIndex, 0, moved);
          void this.plugin.saveSettings();
          this.update();
        },
        onDelete: (index: number) => {
          void this.plugin.removeProject(index).then(() => this.update());
        },
      },
    ];
  }
}

