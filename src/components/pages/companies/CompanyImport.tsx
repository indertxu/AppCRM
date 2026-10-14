import ContactImport from "../contacts/ContactImport";
import type { CompanyField } from "./companiesApi";

/**
 * The Companies page import: the same hybrid importer as Contacts, opened
 * companies-first — a companies file is required, and a contacts file can be
 * added to import both and link them in one go.
 */
export default function CompanyImport({ onClose, onDone }: {
  /** Kept for compatibility; the importer always re-reads the current fields itself. */
  fields?: CompanyField[];
  onClose: () => void;
  onDone: () => void;
}) {
  return <ContactImport primary="company" fields={[]} onClose={onClose} onDone={onDone} />;
}