import { SHORTCUT_GROUPS } from '../../lib/shortcuts/reference';
import { Modal } from '../ui';

/**
 * The complete keyboard reference. Opened from the `?` binding, the topbar
 * button and the workspace panel, so all three routes show the same list.
 */
export function ShortcutReferenceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" wide>
      <div className="stack shortcut-reference">
        <p className="field-hint">
          Shortcuts act on the focused chart panel. They do not fire while you are typing in a form control or while
          another dialog is open. Browser and operating-system shortcuts always take precedence.
        </p>
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.id}>
            <div className="shortcut-group-head">
              <span className="field-label">{group.label}</span>
              <span className="field-hint">{group.description}</span>
            </div>
            <dl className="shortcut-list">
              {group.entries.map((entry) => (
                <div key={entry.id} className="shortcut-row">
                  <dt>
                    {entry.keys.map((key) => (
                      <kbd key={key} className="shortcut-kbd">
                        {key}
                      </kbd>
                    ))}
                  </dt>
                  <dd>
                    {entry.description}
                    {entry.note && <span className="field-hint"> {entry.note}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
