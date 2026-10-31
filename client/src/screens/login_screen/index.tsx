import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PlayCircle } from "lucide-react";
import { DisplayButton, DisplayError } from "components/display_components";
import { authService } from "utils/services/api_services/agentreplay_service";
import { getErrorMessage } from "utils/services/api_services/apiClient";
import { useAuthStore } from "utils/store/authStore";

type Mode = "signin" | "signup";

// One screen for signing in, creating an account and trying the demo.
export const LoginScreen = () => {
  const setSession = useAuthStore((state) => state.setSession);
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("signin");
  const [name, setName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState<"form" | "demo" | null>(null);

  const run = async (kind: "form" | "demo", request: () => ReturnType<typeof authService.login>) => {
    setError("");
    setLoading(kind);
    try {
      const response = await request();
      setSession(response.data.token, response.data.user);
      navigate("/runs", { replace: true });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(null);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    run("form", () =>
      mode === "signin" ? authService.login(email, password) : authService.signup({ name, workspaceName, email, password })
    );
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setError("");
  };

  const canSubmit = mode === "signin" ? Boolean(email && password) : Boolean(name && workspaceName && email && password.length >= 8);

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center gap-2">
          <PlayCircle className="h-7 w-7 text-brand" aria-hidden />
          <span className="text-xl font-semibold tracking-tight">AgentReplay</span>
        </div>
        <h1 className="font-serif text-3xl">See exactly what your AI did, step by step.</h1>
        <p className="mt-2 text-ink-soft">
          AgentReplay records every step of an AI run, lets you replay it, try a fix from any step, and save a failure as a test.
        </p>

        <section className="mt-8 rounded-lg border border-line bg-sheet p-5">
          <h2 className="text-base font-semibold">Just looking around?</h2>
          <p className="mt-1 text-sm text-ink-soft">Open the demo with sample runs. No account or password needed.</p>
          <DisplayButton
            variant="primary"
            size="lg"
            className="mt-3 w-full"
            loading={loading === "demo"}
            disabled={Boolean(loading)}
            onClick={() => run("demo", () => authService.demo())}
          >
            Try the demo
          </DisplayButton>
        </section>

        <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-3" noValidate>
          <div className="flex gap-1 rounded-md bg-ink/5 p-1" role="tablist" aria-label="Sign in or create an account">
            {(["signin", "signup"] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={mode === item}
                onClick={() => switchMode(item)}
                className={`flex-1 rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                  mode === item ? "bg-sheet text-ink shadow-sm" : "text-ink-soft hover:text-ink"
                }`}
              >
                {item === "signin" ? "Sign in" : "Create account"}
              </button>
            ))}
          </div>

          {mode === "signup" && (
            <>
              <div>
                <label htmlFor="name" className="field-label">
                  Your name
                </label>
                <input id="name" autoComplete="name" className="field-input" value={name} onChange={(event) => setName(event.target.value)} required />
              </div>
              <div>
                <label htmlFor="workspaceName" className="field-label">
                  Your team or company name
                </label>
                <input
                  id="workspaceName"
                  autoComplete="organization"
                  className="field-input"
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  required
                />
              </div>
            </>
          )}
          <div>
            <label htmlFor="email" className="field-label">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              className="field-input"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="password" className="field-label">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              className="field-input"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            {mode === "signup" && <p className="mt-1 text-xs text-ink-faint">Use at least 8 characters.</p>}
          </div>
          {error && <DisplayError message={error} />}
          <DisplayButton type="submit" variant="primary" size="lg" loading={loading === "form"} disabled={!canSubmit || Boolean(loading)}>
            {mode === "signin" ? "Sign in" : "Create my account"}
          </DisplayButton>
        </form>
      </div>
    </div>
  );
};
