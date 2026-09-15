import MarketingShell from "@/components/app/MarketingShell";

export default function ClientLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <MarketingShell>{children}</MarketingShell>;
}
