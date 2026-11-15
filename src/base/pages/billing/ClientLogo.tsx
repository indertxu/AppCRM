/* BASE · Billing — a client's logo (its website's icon), or its initial on mint when there's none. */
import { CompanyLogo } from "../companies/CompaniesPage";

export default function ClientLogo({ name, website, size = 34 }: { name: string; website?: string | null; size?: number }) {
  return (
    <span className="bz-logo-wrap" style={{ width: size, height: size, fontSize: size * 0.4 }}>
      <CompanyLogo name={name} website={website || null} className="bz-logo" />
    </span>
  );
}
