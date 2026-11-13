import {
  applicationWithInput,
  checkedApplication,
  checkedObject,
  checkedSettings,
  checkedTimestamp,
  EMPTY_SETTINGS,
  normalizeJobUrl,
  type LocalApplication,
  type LocalApplicationInput,
  type LocalSettings,
} from "./schema";

export { LOCAL_STATUSES, LOCAL_JOB_TYPES } from "./schema";
export type { LocalApplication, LocalApplicationInput, LocalSettings, LocalStatus, LocalJobType } from "./schema";

const DATABASE_NAME = "job-application-tracker-local";
const DATABASE_VERSION = 1;
const BACKUP_VERSION = 1;
const APPLICATIONS = "applications";
const SETTINGS = "settings";
const PROFILE_KEY = "profile";
const REVISION_KEY = "revision";
const BACKUP_KEYS = ["schemaVersion", "exportedAt", "applications", "settings"];
export const MAX_BACKUP_BYTES = 32 * 1024 * 1024;

type LocalBackup = {
  schemaVersion: typeof BACKUP_VERSION;
  exportedAt: string;
  applications: LocalApplication[];
  settings: LocalSettings;
};

export type BackupPreview = Readonly<{
  applicationCount: number;
  hasResume: boolean;
  exportedAt: string;
}>;

const previewBackups = new WeakMap<BackupPreview, LocalBackup>();

export class DuplicateJobUrlError extends Error {
  constructor() {
    super("An application with this job URL already exists.");
    this.name = "DuplicateJobUrlError";
  }
}

export class LocalDataChangedError extends Error {
  constructor() {
    super("Browser data changed. Reload and try again.");
    this.name = "LocalDataChangedError";
  }
}

export class LocalBackupCapacityError extends Error {
  constructor() {
    super("Backup exceeds the 32 MB limit.");
    this.name = "LocalBackupCapacityError";
  }
}

function checkedBackup(value: unknown): LocalBackup {
  const data = checkedObject(value, BACKUP_KEYS, "backup");
  if (data.schemaVersion !== BACKUP_VERSION) throw new Error("Unsupported backup version.");
  if (!Array.isArray(data.applications)) throw new Error("Invalid backup applications.");

  const applications = data.applications.map(checkedApplication);
  if (new Set(applications.map(({ id }) => id)).size !== applications.length) {
    throw new Error("Backup contains duplicate application IDs.");
  }
  return {
    schemaVersion: BACKUP_VERSION,
    exportedAt: checkedTimestamp(data.exportedAt, "backup date"),
    applications,
    settings: checkedSettings(data.settings),
  };
}

function checkBackupSize(json: string): void {
  if (json.length > MAX_BACKUP_BYTES || new Blob([json]).size > MAX_BACKUP_BYTES) {
    throw new LocalBackupCapacityError();
  }
}

function serializeBackup(backup: LocalBackup): string {
  const json = JSON.stringify(backup);
  checkBackupSize(json);
  return json;
}

export function previewBackup(json: string): BackupPreview {
  checkBackupSize(json);
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("Backup is not valid JSON.");
  }
  const backup = checkedBackup(data);
  serializeBackup(backup);
  const preview = Object.freeze({
    applicationCount: backup.applications.length,
    hasResume: Boolean(backup.settings.resumeText.trim()),
    exportedAt: backup.exportedAt,
  });
  previewBackups.set(preview, backup);
  return preview;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    let blocked = false;

    request.onupgradeneeded = () => {
      request.result.createObjectStore(APPLICATIONS, { keyPath: "id" });
      request.result.createObjectStore(SETTINGS);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error("Close other tracker tabs, then try again."));
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      if (blocked) database.close();
      else resolve(database);
    };
  });
}

type TransactionContext<T> = {
  applications: IDBObjectStore;
  settings: IDBObjectStore;
  onResult: <R>(request: IDBRequest<R>, callback: (result: R) => void) => void;
  setResult: (result: T) => void;
};

async function transact<T>(
  mode: IDBTransactionMode,
  operation: (context: TransactionContext<T>) => void,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction([APPLICATIONS, SETTINGS], mode);
      let result: T;
      let failure: unknown;

      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Browser storage operation aborted."));

      function run(callback: () => void) {
        try {
          callback();
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      }

      run(() => operation({
        applications: transaction.objectStore(APPLICATIONS),
        settings: transaction.objectStore(SETTINGS),
        onResult(request, callback) {
          request.onsuccess = () => run(() => callback(request.result));
        },
        setResult(value) {
          result = value;
        },
      }));
    });
  } finally {
    database.close();
  }
}

function putRevision(settings: IDBObjectStore): void {
  settings.put(crypto.randomUUID(), REVISION_KEY);
}

function readBackup<T>(context: TransactionContext<T>, onBackup: (backup: LocalBackup) => void): void {
  const { applications, settings, onResult } = context;
  onResult(applications.getAll(), (records) => {
    onResult(settings.get(PROFILE_KEY), (profile) => {
      onBackup(checkedBackup({
        schemaVersion: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        applications: records,
        settings: profile ?? EMPTY_SETTINGS,
      }));
    });
  });
}

function finishBackupSizedWrite<T>(context: TransactionContext<T>, result: T): void {
  // Reads queued after the write see its pending changes. A failed size check aborts the transaction.
  readBackup(context, (backup) => {
    serializeBackup(backup);
    putRevision(context.settings);
    context.setResult(result);
  });
}

function assertUniqueUrl(records: LocalApplication[], application: LocalApplication): void {
  const canonicalUrl = normalizeJobUrl(application.url);
  if (records.some((record) => record.id !== application.id && normalizeJobUrl(record.url) === canonicalUrl)) {
    throw new DuplicateJobUrlError();
  }
}

function nextTimestamp(previous: string): string {
  return new Date(Math.max(Date.now(), new Date(previous).valueOf() + 1)).toISOString();
}

export function createLocalTrackerStorage() {
  const previewRevisions = new WeakMap<BackupPreview, { revision: string | undefined }>();

  return {
    listApplications(): Promise<LocalApplication[]> {
      return transact("readonly", ({ applications, onResult, setResult }) => {
        onResult(applications.getAll(), (records) => setResult(records.map(checkedApplication)));
      });
    },

    async createApplication(input: LocalApplicationInput): Promise<LocalApplication> {
      const timestamp = new Date().toISOString();
      const application = applicationWithInput({
        id: crypto.randomUUID(),
        url: "",
        jobTitle: "",
        company: "",
        status: "Applied",
        appliedDate: timestamp,
        description: null,
        notes: null,
        salary: null,
        location: null,
        jobType: null,
        nextStep: null,
        nextStepDate: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        identityKey: null,
        canonicalUrl: null,
        duplicateOfId: null,
        identityState: "legacy_unresolved",
      }, input);
      const canonicalUrl = normalizeJobUrl(application.url);
      application.canonicalUrl = canonicalUrl.length <= 2048 ? canonicalUrl : null;

      return transact("readwrite", (context) => {
        const { applications, onResult } = context;
        onResult(applications.getAll(), (records) => {
          assertUniqueUrl(records, application);
          applications.add(application);
          finishBackupSizedWrite(context, application);
        });
      });
    },

    updateApplication(
      id: string,
      patch: Partial<LocalApplicationInput>,
      expectedUpdatedAt?: string,
    ): Promise<LocalApplication> {
      return transact("readwrite", (context) => {
        const { applications, onResult } = context;
        onResult(applications.get(id), (record) => {
          if (!record) throw new LocalDataChangedError();
          const previous = checkedApplication(record);
          if (expectedUpdatedAt !== undefined && previous.updatedAt !== expectedUpdatedAt) {
            throw new LocalDataChangedError();
          }
          const application = applicationWithInput({ ...previous, updatedAt: nextTimestamp(previous.updatedAt) }, patch);
          const save = () => {
            applications.put(application);
            finishBackupSizedWrite(context, application);
          };
          if (application.url === previous.url) {
            save();
            return;
          }
          onResult(applications.getAll(), (records) => {
            assertUniqueUrl(records, application);
            application.identityKey = null;
            const canonicalUrl = normalizeJobUrl(application.url);
            application.canonicalUrl = canonicalUrl.length <= 2048 ? canonicalUrl : null;
            application.duplicateOfId = null;
            application.identityState = "legacy_unresolved";
            save();
          });
        });
      });
    },

    deleteApplication(id: string, expectedUpdatedAt?: string): Promise<void> {
      return transact("readwrite", ({ applications, settings, onResult }) => {
        onResult(applications.get(id), (record) => {
          if (expectedUpdatedAt !== undefined && record?.updatedAt !== expectedUpdatedAt) {
            throw new LocalDataChangedError();
          }
          if (record) {
            applications.delete(id);
            putRevision(settings);
          }
        });
      });
    },

    getSettings(): Promise<LocalSettings> {
      return transact("readonly", ({ settings, onResult, setResult }) => {
        onResult(settings.get(PROFILE_KEY), (profile) => setResult(checkedSettings(profile ?? EMPTY_SETTINGS)));
      });
    },

    async saveSettings(settings: LocalSettings, expectedSettings?: LocalSettings): Promise<void> {
      const profile = checkedSettings(settings);
      return transact("readwrite", (context) => {
        const { settings, onResult } = context;
        onResult(settings.get(PROFILE_KEY), (current) => {
          const currentProfile = checkedSettings(current ?? EMPTY_SETTINGS);
          if (expectedSettings && (
            currentProfile.linkedinUrl !== expectedSettings.linkedinUrl ||
            currentProfile.githubUrl !== expectedSettings.githubUrl ||
            currentProfile.resumeText !== expectedSettings.resumeText
          )) {
            throw new LocalDataChangedError();
          }
          settings.put(profile, PROFILE_KEY);
          finishBackupSizedWrite(context, undefined);
        });
      });
    },

    exportBackup(): Promise<string> {
      return transact("readonly", (context) => {
        readBackup(context, (backup) => context.setResult(serializeBackup(backup)));
      });
    },

    async previewBackup(json: string): Promise<BackupPreview> {
      const preview = previewBackup(json);
      return transact("readonly", ({ settings, onResult, setResult }) => {
        onResult(settings.get(REVISION_KEY), (revision) => {
          previewRevisions.set(preview, { revision });
          setResult(preview);
        });
      });
    },

    async restoreBackup(preview: BackupPreview): Promise<void> {
      const backup = previewBackups.get(preview);
      const expected = previewRevisions.get(preview);
      if (!backup || !expected) throw new Error("Preview a valid backup before restoring.");

      await transact<void>("readwrite", ({ applications, settings, onResult }) => {
        onResult(settings.get(REVISION_KEY), (revision) => {
          if (revision !== expected.revision) throw new LocalDataChangedError();
          applications.clear();
          for (const application of backup.applications) applications.add(application);
          settings.put(backup.settings, PROFILE_KEY);
          putRevision(settings);
        });
      });
      previewBackups.delete(preview);
      previewRevisions.delete(preview);
    },
  };
}
