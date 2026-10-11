export const metadata = { title: "Gebruiksvoorwaarden — SocialFlow" };

export default function VoorwaardenPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-bold">Gebruiksvoorwaarden</h1>
      <p className="mt-2 text-sm text-muted">Laatst bijgewerkt: 17 juli 2026</p>

      <div className="mt-8 flex flex-col gap-6 text-sm leading-relaxed text-foreground/90">
        <section>
          <h2 className="mb-2 text-lg font-semibold">1. De dienst</h2>
          <p>
            SocialFlow is een tool om content te plannen en te publiceren naar
            socialmedia-accounts die jij zelf koppelt (waaronder Instagram, Facebook,
            TikTok en YouTube). Door de app te gebruiken ga je akkoord met deze
            voorwaarden.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-semibold">2. Jouw verantwoordelijkheid</h2>
          <ul className="list-disc pl-5">
            <li>Je koppelt alleen accounts waarvan je zelf eigenaar of beheerder bent.</li>
            <li>
              Je publiceert alleen content waarvoor je de rechten hebt en die voldoet
              aan de richtlijnen van de betreffende platforms (Meta, TikTok, YouTube).
            </li>
            <li>Je houdt je inloggegevens en gekoppelde accounts zelf veilig.</li>
          </ul>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-semibold">3. Platformregels</h2>
          <p>
            Publicatie verloopt via de officiële API&apos;s van de platforms. De
            gebruiksvoorwaarden van die platforms blijven onverkort van toepassing op
            de content die je via SocialFlow plaatst.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-semibold">4. Beschikbaarheid &amp; aansprakelijkheid</h2>
          <p>
            SocialFlow wordt geleverd &quot;zoals het is&quot;, zonder garantie op
            ononderbroken beschikbaarheid. Wij zijn niet aansprakelijk voor schade door
            het niet (tijdig) publiceren van content of door wijzigingen aan de
            API&apos;s van derden.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-semibold">5. Beëindiging</h2>
          <p>
            Je kunt je koppelingen en gegevens op elk moment verwijderen via de app of
            per e-mail. Wij kunnen toegang beëindigen bij misbruik van de dienst.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-semibold">6. Contact</h2>
          <p>
            Vragen over deze voorwaarden:{" "}
            <a className="underline" href="mailto:hassan@mooremultimedia.nl">
              hassan@mooremultimedia.nl
            </a>
            .
          </p>
        </section>
      </div>
    </main>
  );
}
