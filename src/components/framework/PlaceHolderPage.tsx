import "./PlaceholderPage.css";

interface PlaceholderPageProps {
  title: string;
  subtitle?: string;
}

export default function PlaceholderPage({ title, subtitle }: PlaceholderPageProps) {
  return (
    <div className="ph">
      <div className="ph-content">
        <div className="ph-badge" aria-hidden="true" />
        <h1 className="ph-title">{title}</h1>
        <p className="ph-sub">{subtitle ?? "Coming soon."}</p>
      </div>
    </div>
  );
}