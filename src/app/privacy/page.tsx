export const metadata = { title: "Privacybeleid — SocialFlow" };

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-bold">Privacybeleid</h1>
      <p className="mt-2 text-sm text-muted">Laatst bijgewerkt: 17 juli 2026</p>

      <div className="mt-8 flex flex-col gap-6 text-sm leading-relaxed text-foreground/90">
        <section>
          <h2 className="mb-2 text-lg font-semibold">1. Wie wij zijn</h2>
          <p>
            SocialFlow (&quot;wij&quot;) is een social-media-beheertool waarmee je content
            plant en publiceert naar gekoppelde socialmedia-accounts, waaronder
            Instagram, Facebook, TikTok en YouTube. Contact:{" "}
            <a className="underline" href="mailto:hassan@mooremultimedia.nl">
              hassan@mooremultimedia.nl
            </a>
            .
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-semibold">2. Welke gegevens we verwerken</h2>
          <ul className="list-disc pl-5">
            <li>
              <strong>Accountkoppelingen:</strong> toegangstokens die de platforms
              (Meta, TikTok, Google/YouTube) na jouw toestemming verstrekken.
            </li>
            <li>
              <strong>Profielbasisgegevens:</strong> accountnaam/gebruikersnaam en
              account-ID van gekoppelde profielen.
            </li>
            <li>
              <strong>Content:</strong> de foto&apos;s, video&apos;s en teksten die jij
              uploadt om te publiceren.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-semibold">3. Waarvoor we ze gebruiken</h2>
          <p>
            Uitsluitend om de dienst te leveren: content publiceren naar de door jou
            gekoppelde accounts en de status van koppelingen tonen. We verkopen geen
            gegevens en delen niets met derden, behalve met de platforms waarnaar jij
            zelf publiceert.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-semibold">4. Opslag &amp; beveiliging</h2>
          <p>
            Tokens en media worden versleuteld in transit (HTTPS) en opgeslagen bij
            onze hostingpartner (Vercel, met Upstash/Blob-opslag). Toegang is beperkt
            tot de accounteigenaar.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-semibold">5. Verwijdering</h2>
          <p>
            Je kunt een koppeling op elk moment ontkoppelen in de app
            (&quot;Kanalen&quot;); bijbehorende tokens worden dan verwijderd. Voor
            volledige verwijdering van je gegevens mail je{" "}
            <a className="underline" href="mailto:hassan@mooremultimedia.nl">
              hassan@mooremultimedia.nl
            </a>
            ; we verwijderen binnen 30 dagen.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-semibold">6. Rechten (AVG)</h2>
          <p>
            Je hebt recht op inzage, correctie en verwijdering van je gegevens.
            Neem daarvoor contact op via bovenstaand e-mailadres.
          </p>
        </section>
      </div>
    </main>
  );
}
