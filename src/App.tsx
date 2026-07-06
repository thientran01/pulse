function App() {
  return (
    <div className="flex h-full items-center justify-center bg-surface/90 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-border/10 bg-surface-2 p-5">
        <p className="text-sm font-medium text-fg">Pulse</p>
        <p className="mt-1 text-sm text-muted">
          Token smoke test — replaced by the player widget in M1.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <button
            className="rounded-lg bg-fg px-3 py-1.5 text-sm font-medium text-surface transition-transform duration-2 ease-out-tk active:scale-[0.97]"
            type="button"
          >
            Primary
          </button>
          <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs text-accent">
            accent flourish
          </span>
        </div>
      </div>
    </div>
  );
}

export default App;
