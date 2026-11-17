import { useEffect, useRef } from 'react';
import hawLogo from '../assets/haw-logo.png';
import AppLogo from './AppLogo.jsx';

/* global __BUILD_INFO__ */
const INFO = typeof __BUILD_INFO__ !== 'undefined' ? __BUILD_INFO__ : {};

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Über-Dialog: Version, Git-Stand, Link zum Repository. */
export default function AboutDialog({ open, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    if (!open && dlg.open) dlg.close();
  }, [open]);

  const short = INFO.commit ? INFO.commit.slice(0, 7) : '';
  const commitUrl = INFO.commit && INFO.repoUrl ? `${INFO.repoUrl}/commit/${INFO.commit}` : null;

  return (
    <dialog
      ref={ref}
      className="about-dialog"
      onClose={onClose}
      // Klick auf den abgedunkelten Hintergrund schließt den Dialog
      onClick={(e) => e.target === ref.current && onClose()}
      aria-labelledby="about-title"
    >
      <div className="about-body">
        <div className="about-logo">
          <img src={hawLogo} alt="HAW Hamburg" />
        </div>
        <h2 id="about-title" className="about-title">
          <AppLogo size={30} />
          <span>
            Renode4MC<span className="about-accent">-HAW</span>
          </span>
        </h2>
        <p className="about-sub">
          Simulator for the microcontroller lab (TI TM4C1294), based on Renode
          <br />
          HAW Hamburg · Faculty EMI · Microcontroller Lab
        </p>

        <dl className="about-facts">
          <dt>Version</dt>
          <dd>{INFO.version || 'unknown'}</dd>

          <dt>Git commit</dt>
          <dd>
            {short ? (
              <>
                <a href={commitUrl} target="_blank" rel="noopener noreferrer" title={INFO.commit}>
                  <code>{short}</code>
                </a>
                {INFO.dirty && <span className="about-dirty"> + local changes</span>}
                {INFO.branch && <span className="about-muted"> ({INFO.branch})</span>}
              </>
            ) : (
              <span className="about-muted">unknown</span>
            )}
          </dd>

          {INFO.commitDate && (
            <>
              <dt>Date</dt>
              <dd>{formatDate(INFO.commitDate)}</dd>
            </>
          )}

          <dt>Built</dt>
          <dd>{formatDate(INFO.buildDate) || 'unknown'}</dd>

          <dt>Repository</dt>
          <dd>
            <a href={INFO.repoUrl} target="_blank" rel="noopener noreferrer">
              {INFO.repoUrl?.replace(/^https?:\/\//, '')}
            </a>
          </dd>
        </dl>

        <div className="about-actions">
          <button type="button" className="btn primary" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}
