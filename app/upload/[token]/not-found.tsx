/** Wrong, closed or expired link: HTTP 404 with the same calm page as before. */
export default function InvalidLink() {
  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-2xl font-semibold text-ink">Link not found</h1>
      <p className="text-sm text-slate">
        This upload link is invalid or has expired. If you think this is a
        mistake, please reply to the email we sent you.
      </p>
    </main>
  );
}
