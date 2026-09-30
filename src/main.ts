import {
  App,
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

interface ReaderProject {
  id: string;
  repository: string;
  branch: string;
  kbRoot: string;
  localFolder: string;
}

interface SyncedFileState {
  sha: string;
  mtime: number;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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
    const projects = (saved?.projects ?? []).map((project) => ({
      id: project.id || projectId(),
      repository: project.repository ?? "",
      branch: project.branch ?? "",
      kbRoot: project.kbRoot || "Knowledge Base",
      localFolder: project.localFolder ?? "",
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
  }

  private apiPath(repository: string, path: string, branch: string): string {
    const encodedPath = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    return `https://api.github.com/repos/${repository}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;
  }

  private async resolveBranch(project: ReaderProject): Promise<string> {
    const configured = project.branch.trim();
    if (configured) return configured;

    const repo = await this.github<{ default_branch: string }>(
      `https://api.github.com/repos/${project.repository}`,
    );
    return repo.default_branch;
  }

  private decodeBase64Bytes(content: string): Uint8Array {
    const binary = atob(content.replace(/\n/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  private async listRecursive(
    repository: string,
    branch: string,
    path: string,
  ): Promise<GitHubContentItem[]> {
    const items = await this.github<GitHubContentItem[]>(this.apiPath(repository, path, branch));
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

    const parts = normalized.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private async writeBinary(path: string, bytes: Uint8Array): Promise<TFile> {
    const normalized = normalizePath(path);
    const slash = normalized.lastIndexOf("/");
    if (slash >= 0) await this.ensureFolder(normalized.slice(0, slash));

    const existing = this.app.vault.getAbstractFileByPath(normalized);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, buffer);
      return existing;
    }
    if (!existing) {
      return await this.app.vault.createBinary(normalized, buffer);
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
      throw new Error("KB root cannot be empty.");
    }
  }

  async syncProject(project: ReaderProject): Promise<void> {
    this.validateProject(project);

    const repository = normalizedRepo(project.repository);
    const branch = await this.resolveBranch({ ...project, repository });
    const kbRoot = project.kbRoot.trim().replace(/^\/+|\/+$/g, "");
    const projectName = repository.split("/").pop() || "Project";
    const localRoot = normalizePath(project.localFolder.trim() || `Sparkore KB/${projectName}`);

    const files = await this.listRecursive(repository, branch, kbRoot);
    const state = this.settings.syncState[project.id] ?? { files: {} };
    const nextFiles: Record<string, SyncedFileState> = {};
    let downloaded = 0;
    let unchanged = 0;

    for (const item of files) {
      const relative = item.path.startsWith(`${kbRoot}/`)
        ? item.path.slice(kbRoot.length + 1)
        : item.name;
      const localPath = normalizePath(`${localRoot}/${relative}`);
      const local = this.app.vault.getAbstractFileByPath(localPath);
      const previous = state.files[relative];

      if (
        local instanceof TFile &&
        previous?.sha === item.sha &&
        previous.mtime === local.stat.mtime
      ) {
        nextFiles[relative] = previous;
        unchanged += 1;
        continue;
      }

      const bytes = await this.fetchFile(item);
      const written = await this.writeBinary(localPath, bytes);
      nextFiles[relative] = { sha: item.sha, mtime: written.stat.mtime };
      downloaded += 1;
    }

    let removed = 0;
    if (this.settings.pruneDeleted) {
      for (const oldRelative of Object.keys(state.files)) {
        if (nextFiles[oldRelative]) continue;
        const oldPath = normalizePath(`${localRoot}/${oldRelative}`);
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

    new Notice(
      `Sparkore KB Reader: ${projectName} refreshed · ${downloaded} updated · ${unchanged} unchanged · ${removed} removed.`
    );
  }

  async syncAll(): Promise<void> {
    if (this.settings.projects.length === 0) {
      new Notice("Sparkore KB Reader: add a project in settings first.");
      return;
    }

    for (const project of this.settings.projects) {
      try {
        await this.syncProject(project);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`Sparkore KB Reader: ${project.repository} failed — ${message}`, 10000);
      }
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
      desc: `${project.branch || "Default branch"} · ${project.kbRoot || "Knowledge Base"}`,
      items: [
        {
          name: "Repository",
          desc: "GitHub repository in owner/repo format or a GitHub repository URL.",
          render: (setting: Setting) => {
            setting.addText((text) => text
              .setValue(project.repository)
              .setPlaceholder("owner/repo")
              .onChange(async (value) => {
                project.repository = normalizedRepo(value);
                await this.plugin.saveSettings();
              }));
          },
        },
        {
          name: "Branch",
          desc: "Leave empty to follow the repository default branch.",
          render: (setting: Setting) => {
            setting.addText((text) => text
              .setValue(project.branch)
              .setPlaceholder("Default branch")
              .onChange(async (value) => {
                project.branch = value.trim();
                await this.plugin.saveSettings();
              }));
          },
        },
        {
          name: "KB root",
          desc: "Repository folder to fetch into the local reading cache.",
          render: (setting: Setting) => {
            setting.addText((text) => text
              .setValue(project.kbRoot)
              .setPlaceholder("Knowledge Base")
              .onChange(async (value) => {
                project.kbRoot = value.trim();
                await this.plugin.saveSettings();
              }));
          },
        },
        {
          name: "Local folder",
          desc: "Vault folder for the local cache. Leave empty to use Sparkore KB/<repo>.",
          render: (setting: Setting) => {
            setting.addText((text) => text
              .setValue(project.localFolder)
              .setPlaceholder("Sparkore KB/<repo>")
              .onChange(async (value) => {
                project.localFolder = value.trim();
                await this.plugin.saveSettings();
              }));
          },
        },
        {
          name: "Refresh now",
          desc: "Fetch the selected branch and KB path from GitHub.",
          action: () => {
            void this.plugin.syncProject(project);
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
              kbRoot: "Knowledge Base",
              localFolder: "",
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

