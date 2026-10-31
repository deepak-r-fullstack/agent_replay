import { FormEvent, useState } from "react";
import { Check, Copy, KeyRound, Plus } from "lucide-react";
import { DisplayBadge, DisplayButton, DisplayEmptyState, DisplayError, DisplayLoading, DisplayPageHeader, DisplayTip } from "components/display_components";
import { useApps, useCreateApp, useRevokeKey, useRotateKey } from "utils/hooks/useAgentReplayQueries";
import { getErrorMessage } from "utils/services/api_services/apiClient";
import { formatDate } from "utils/helper_functions/format";
import { useAuthStore } from "utils/store/authStore";
import { showToast } from "utils/store/toastStore";
import { AppSummary, AppWithKey } from "utils/types";

const copyText = async (text: string, doneMessage: string) => {
  try {
    await navigator.clipboard.writeText(text);
    showToast(doneMessage);
  } catch {
    showToast("Could not copy. Select the text and copy it by hand.", "error");
  }
};

// Shown right after a key is made. The key cannot be shown again, so this card says so clearly.
const NewKeyCard = ({ app, onDone }: { app: AppWithKey; onDone: () => void }) => {
  const setup = `npm install agentreplay\n\n# Put this in your app's environment settings:\nAGENTREPLAY_API_KEY=${app.apiKey}`;
  return (
    <section className="mb-6 rounded-lg border border-done/30 bg-done-tint p-5" aria-live="polite">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <Check className="h-5 w-5 text-done" aria-hidden /> Your key for {app.name} is ready
      </h2>
      <p className="mt-1 text-ink">
        Copy it now and keep it somewhere safe. <strong>For your safety, we cannot show it again.</strong> If you lose it, make a new one.
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start">
        <code className="block flex-1 overflow-x-auto whitespace-pre rounded-md bg-ink px-3 py-2 text-xs leading-relaxed text-white">{setup}</code>
        <DisplayButton icon={<Copy className="h-4 w-4" aria-hidden />} onClick={() => copyText(setup, "Copied. Paste it into your app.")}>
          Copy
        </DisplayButton>
      </div>
      <DisplayButton className="mt-4" variant="primary" onClick={onDone}>
        I have saved it
      </DisplayButton>
    </section>
  );
};

const AppRow = ({ app, canEdit, onNewKey }: { app: AppSummary; canEdit: boolean; onNewKey: (app: AppWithKey) => void }) => {
  const rotate = useRotateKey();
  const revoke = useRevokeKey();
  const [confirming, setConfirming] = useState<"rotate" | "revoke" | null>(null);

  const confirmAndRun = () => {
    if (confirming === "rotate") rotate.mutate(app.id, { onSuccess: onNewKey });
    if (confirming === "revoke") revoke.mutate(app.id);
    setConfirming(null);
  };

  return (
    <li className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          {app.name}
          <DisplayBadge label={app.active ? "Key active" : "Key switched off"} tone={app.active ? "done" : "refused"} />
        </p>
        <p className="mt-0.5 text-sm text-ink-soft">
          Key starts with <code className="rounded bg-ink/5 px-1">{app.apiKeyPreview}</code> · added {formatDate(app.createdAt)}
        </p>
      </div>
      {canEdit &&
        (confirming ? (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`Confirm for ${app.name}`}>
            <span className="text-sm text-ink-soft">
              {confirming === "revoke" ? "The app stops recording straight away." : "The old key stops working straight away."} Sure?
            </span>
            <DisplayButton variant={confirming === "revoke" ? "danger" : "primary"} loading={rotate.isPending || revoke.isPending} onClick={confirmAndRun}>
              {confirming === "revoke" ? "Yes, switch it off" : "Yes, make a new key"}
            </DisplayButton>
            <DisplayButton variant="ghost" onClick={() => setConfirming(null)}>
              Cancel
            </DisplayButton>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <DisplayButton onClick={() => setConfirming("rotate")}>{app.active ? "Make a new key" : "Switch back on"}</DisplayButton>
            {app.active && (
              <DisplayButton variant="danger" onClick={() => setConfirming("revoke")}>
                Switch key off
              </DisplayButton>
            )}
          </div>
        ))}
    </li>
  );
};

// Apps that send runs to AgentReplay, and the secret key each one uses.
export const AppsScreen = () => {
  const { data: apps, isLoading, error, refetch } = useApps();
  const createApp = useCreateApp();
  const role = useAuthStore((state) => state.user?.role);
  const canEdit = role === "owner" || role === "developer";
  const [name, setName] = useState("");
  const [newKey, setNewKey] = useState<AppWithKey | null>(null);

  const onCreate = (event: FormEvent) => {
    event.preventDefault();
    createApp.mutate(name, {
      onSuccess: (app) => {
        setNewKey(app);
        setName("");
      },
    });
  };

  return (
    <>
      <DisplayPageHeader
        title="Apps and keys"
        description={
          <>
            An app is anything that uses AI and sends its runs here. Each app gets its own secret key (an <DisplayTip term="SDK key" meaning="A secret password that lets your app send its recordings to AgentReplay." />) so we know where each run came from.
          </>
        }
      />

      {newKey && <NewKeyCard app={newKey} onDone={() => setNewKey(null)} />}

      {canEdit ? (
        <form onSubmit={onCreate} className="mb-6 rounded-lg border border-line bg-sheet p-5">
          <label htmlFor="appName" className="field-label">
            Add an app
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="appName"
              className="field-input"
              placeholder="For example: Support assistant"
              value={name}
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
            />
            <DisplayButton type="submit" variant="primary" loading={createApp.isPending} disabled={!name.trim()} icon={<Plus className="h-4 w-4" aria-hidden />} className="shrink-0">
              Add app
            </DisplayButton>
          </div>
        </form>
      ) : (
        <p className="mb-6 rounded-lg border border-line bg-sheet px-4 py-3 text-sm text-ink-soft">
          You can look at apps, but only an owner or developer can add or change them.
        </p>
      )}

      {isLoading && <DisplayLoading label="Loading your apps" />}
      {error && <DisplayError message={getErrorMessage(error)} onRetry={() => refetch()} />}
      {apps && apps.length === 0 && (
        <DisplayEmptyState
          title="No apps yet"
          description={canEdit ? "Add your first app above. You will get a key to paste into your code, and its runs will appear here." : "Ask an owner or developer to add the first app."}
          action={<KeyRound className="mx-auto h-6 w-6 text-ink-faint" aria-hidden />}
        />
      )}
      {apps && apps.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line bg-sheet">
          {apps.map((app) => (
            <AppRow key={app.id} app={app} canEdit={canEdit} onNewKey={setNewKey} />
          ))}
        </ul>
      )}
    </>
  );
};
