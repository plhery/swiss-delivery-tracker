export default function OfflinePage() {
  return (
    <main className="auth-screen">
      <section className="auth-card" aria-labelledby="offline-title">
        <div className="auth-card__mark" aria-hidden="true"><span /></div>
        <p className="auth-card__eyebrow">Swiss Delivery Tracker</p>
        <h1 id="offline-title">You’re offline</h1>
        <p className="auth-card__intro">
          Reconnect to refresh carrier updates. Parcels you already opened remain available.
        </p>
        {/* A real navigation retries the document and service worker after connectivity returns. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a className="button button--primary" href="/">Try again</a>
      </section>
    </main>
  );
}
