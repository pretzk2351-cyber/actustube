import "./globals.css";
import Providers from "./providers";

export const metadata = {
  title: "ActusTube",
  description: "YouTube analysis dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}