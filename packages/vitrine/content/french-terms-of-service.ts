import type {
  LegalBlock,
  LegalSection,
} from "@/components/legal-document-page";
import { legalDocumentReadyForPublication } from "@/content/legal-publication";
import { publisher } from "@/lib/publisher";

const paragraph = (text: string): LegalBlock => ({ type: "paragraph", text });
const list = (...items: string[]): LegalBlock => ({ type: "list", items });
const notice = (
  title: string,
  paragraphs: readonly string[],
  items?: readonly string[],
): LegalBlock => ({ type: "notice", title, paragraphs, items });

export const frenchTermsEffectiveDate = "19 juillet 2026";
export const frenchTermsLastUpdated = "9 novembre 2026";
export const frenchTermsVersion = "1.1";

export const frenchTermsIntroduction = [
  `Les présentes Conditions Générales de Service et de Vente constituent le contrat entre le Client et Raphael Charpentier, entrepreneur individuel soumis au régime de la micro-entreprise et exerçant sous le nom commercial MK Holding, domicilié ${publisher.address}, immatriculé au Registre national des entreprises et au R.C.S. de Lyon sous le numéro SIREN ${publisher.siren} (« Blame », « nous »). TVA non applicable, article 293 B du Code général des impôts.`,
  "Elles régissent le téléchargement, l'installation, l'accès et l'utilisation de l'application Blame Desktop, du site, des services cloud, des API, des mises à jour et du support. Le Client doit les lire et les accepter avant de commander. Les droits impératifs du consommateur demeurent intégralement applicables.",
  "La version française prévaut pour les consommateurs en France. Les clauses expressément réservées aux Clients professionnels ne s'appliquent pas aux consommateurs.",
] as const;

export const frenchTermsSections = [
  {
    id: "identite-champ",
    title: "1. Identité du prestataire et champ d'application",
    blocks: [
      paragraph(
        `Blame est le fournisseur et le concédant de licence du Service. Le Client peut écrire à legal@blame.so pour toute question juridique, à support@blame.so pour le support et appeler le ${publisher.phone}.`,
      ),
      paragraph(
        "Les présentes conditions s'appliquent aux comptes gratuits ou payants, abonnements, essais et programmes d'accès anticipé qui y renvoient. Les caractéristiques, le prix total, la périodicité, la durée et les éventuelles conditions particulières affichées avant la commande complètent les présentes conditions.",
      ),
      paragraph(
        "La Politique de confidentialité, la Refund Policy et, lorsque Blame traite des données personnelles pour le compte d'un Client professionnel, le Data Processing Addendum sont incorporés au contrat dans leur champ respectif. En cas de contradiction, un bon de commande signé prévaut, puis les conditions particulières acceptées à la commande, les présentes conditions et les politiques incorporées.",
      ),
    ],
  },
  {
    id: "definitions",
    title: "2. Définitions",
    blocks: [
      list(
        "« Abonnement » : droit payant d'accéder au Service pendant la période choisie à la commande.",
        "« Application » : logiciel Blame Desktop et ses mises à jour.",
        "« Client » ou « vous » : personne qui accepte le contrat ou organisation valablement représentée par elle.",
        "« Client professionnel » : personne qui contracte principalement dans le cadre de son activité professionnelle.",
        "« Consommateur » : personne physique agissant à des fins n'entrant pas dans le cadre de son activité professionnelle.",
        "« Contenu Client » : code, fichiers, dépôts, prompts, messages, pièces jointes et autres données confiées au Service.",
        "« Fournisseur d'IA » : fournisseur de modèle ou de service d'intelligence artificielle sélectionné ou connecté par le Client.",
        "« Service » : l'Application, le site, les comptes, la facturation, la synchronisation cloud, les API, l'orchestration d'agents, les mises à jour et le support Blame.",
      ),
    ],
  },
  {
    id: "formation-contrat",
    title: "3. Formation du contrat et commande",
    blocks: [
      paragraph(
        "Le Client doit avoir au moins treize ans. Lorsqu'une loi exige un âge supérieur ou l'autorisation d'un représentant légal, cette condition supplémentaire s'applique. Un consommateur mineur ne peut souscrire un Abonnement payant que dans les limites autorisées par la loi et avec l'autorisation requise.",
      ),
      paragraph(
        "Avant la commande, le Client peut vérifier le plan, la périodicité, le prix total, les fonctionnalités essentielles, la compatibilité, la durée, la reconduction et corriger ses informations. Le contrat est conclu lorsque le Client accepte expressément les conditions, confirme une commande impliquant paiement et que le paiement est accepté.",
      ),
      paragraph(
        "Le Client reçoit ou peut conserver sur un support durable les conditions applicables et la confirmation de commande. Blame peut refuser une nouvelle commande pour un motif légitime, notamment indisponibilité territoriale, sanctions, fraude, incapacité technique ou impossibilité de satisfaire une obligation légale, sans affecter un contrat déjà formé.",
      ),
    ],
  },
  {
    id: "description-service",
    title: "4. Description, fonctionnalités et prérequis",
    blocks: [
      paragraph(
        "Blame fournit un environnement de développement agentique permettant notamment de gérer des projets, user stories et pratiques de code, d'orchestrer des agents, d'isoler des travaux, de prévisualiser et examiner des modifications et de synchroniser certains états avec le cloud Blame.",
      ),
      paragraph(
        "L'exécution de code intervient normalement sur l'appareil du Client ou dans un environnement local virtualisé ou conteneurisé. Le cloud Blame héberge le plan de contrôle, le compte, les états synchronisés et les fonctions indiquées dans la description du plan. L'utilisation peut transmettre les éléments sélectionnés à un Fournisseur d'IA, serveur MCP ou autre service tiers choisi par le Client.",
      ),
      paragraph(
        "Les systèmes d'exploitation, architectures, ressources matérielles, dépendances, autorisations, accès réseau, fonctions, compatibilités, interopérabilités et mesures de protection technique applicables sont décrits avant la commande ou dans la documentation accessible depuis https://blame.so. Le Client doit vérifier ces prérequis avant l'installation.",
      ),
    ],
  },
  {
    id: "compte-securite",
    title: "5. Compte, appareils et sécurité",
    blocks: [
      paragraph(
        "Le Client fournit des informations exactes, maintient son adresse électronique à jour et protège ses identifiants, clés, jetons, appareils et moyens de récupération. Il informe rapidement security@blame.so de tout accès non autorisé ou incident affectant le Service.",
      ),
      paragraph(
        "Sauf conditions particulières, un Abonnement standard est attribué à un développeur nommé et permet d'activer l'Application sur trois appareils contrôlés par ce développeur. Un appareil peut être remplacé après désactivation de l'ancien. Les machines virtuelles et conteneurs locaux créés sur un appareil activé ne comptent pas séparément.",
      ),
      paragraph(
        "Le partage, la revente ou le transfert non autorisé d'un compte sont interdits. Le Client reste responsable des actions effectuées avec ses identifiants lorsqu'elles résultent d'un manquement qui lui est imputable, sans préjudice des règles impératives relatives aux paiements et à la sécurité.",
      ),
    ],
  },
  {
    id: "prix-paiement",
    title: "6. Prix, paiement, facturation et taxes",
    blocks: [
      paragraph(
        "L'offre publique est de 13 euros par mois ou 120 euros par an, sauf prix différent clairement affiché et accepté avant la commande. Les prix proposés aux consommateurs sont les prix totaux à payer. TVA non applicable, article 293 B du Code général des impôts. Aucune TVA n'est actuellement ajoutée.",
      ),
      paragraph(
        "Les paiements sont traités par Stripe. Le Client autorise le débit du prix initial et de chaque renouvellement valablement annoncé. Blame ne reçoit pas le numéro complet de carte ni le cryptogramme. Les frais d'un Fournisseur d'IA, serveur MCP, dépôt, hébergeur ou autre service choisi par le Client ne sont pas inclus sauf indication expresse.",
      ),
      notice("Clients professionnels facturés hors paiement immédiat", [
        "Une facture est payable à trente jours sauf mention différente. Les pénalités de retard sont exigibles de plein droit dès le lendemain de l'échéance au taux de refinancement de la Banque centrale européenne applicable augmenté de dix points, sans pouvoir être inférieur au minimum légal. L'indemnité forfaitaire légale de 40 euros pour frais de recouvrement est due, outre les frais supplémentaires justifiés récupérables. Aucun escompte pour paiement anticipé n'est accordé sauf mention contraire.",
      ]),
    ],
  },
  {
    id: "renouvellement",
    title: "7. Durée, reconduction, résiliation et remboursement",
    blocks: [
      paragraph(
        "L'Abonnement est conclu pour un mois ou un an selon la formule choisie. Il se reconduit tacitement pour des périodes successives identiques jusqu'à résiliation. Blame adresse au consommateur l'information de non-reconduction requise dans les délais légaux.",
      ),
      paragraph(
        "Le Client peut résilier gratuitement depuis le portail client Stripe ouvert par le lien « Billing » de la rubrique « Consumer rights » sur blame.so, ou par écrit à billing@blame.so. Le portail de facturation permet au Client de gérer et de résilier son abonnement en ligne.",
      ),
      paragraph(
        "Sauf droit légal ou demande contraire acceptée, la résiliation arrête le prochain renouvellement et prend effet à la fin de la période déjà payée, sans indemnité. L'accès reste disponible jusque-là. La résiliation ne ferme pas le compte et ne supprime pas les données ou fichiers locaux.",
      ),
      paragraph(
        "Les sommes payées ne sont pas remboursables au prorata d'une période inutilisée, sauf rétractation, défaut de conformité, facturation erronée, engagement commercial exprès, arrêt anticipé du Service par Blame ou autre droit impératif. La Refund Policy à https://blame.so/refund-policy précise ces cas sans limiter les droits légaux.",
      ),
      notice(
        "Reproduction des articles L. 215-1 à L. 215-3 et L. 241-3 du Code de la consommation",
        [
          "Article L. 215-1 : Pour les contrats de prestations de services conclus pour une durée déterminée avec une clause de reconduction tacite, le professionnel prestataire de services informe le consommateur par écrit, par lettre nominative ou courrier électronique dédiés, au plus tôt trois mois et au plus tard un mois avant le terme de la période autorisant le rejet de la reconduction, de la possibilité de ne pas reconduire le contrat qu'il a conclu avec une clause de reconduction tacite. Cette information, délivrée dans des termes clairs et compréhensibles, mentionne, dans un encadré apparent, la date limite de non-reconduction. Lorsque cette information ne lui a pas été adressée conformément aux dispositions du premier alinéa, le consommateur peut mettre gratuitement un terme au contrat, à tout moment à compter de la date de reconduction. Les avances effectuées après la dernière date de reconduction ou, s'agissant des contrats à durée indéterminée, après la date de transformation du contrat initial à durée déterminée, sont dans ce cas remboursées dans un délai de trente jours à compter de la date de résiliation, déduction faite des sommes correspondant, jusqu'à celle-ci, à l'exécution du contrat. Les dispositions du présent article s'appliquent sans préjudice de celles qui soumettent légalement certains contrats à des règles particulières en ce qui concerne l'information du consommateur.",
          "Article L. 215-1-1 : Lorsqu'un contrat a été conclu par voie électronique ou a été conclu par un autre moyen et que le professionnel, au jour de la résiliation par le consommateur, offre au consommateur la possibilité de conclure des contrats par voie électronique, la résiliation est rendue possible selon cette modalité. A cet effet, le professionnel met à la disposition du consommateur une fonctionnalité gratuite permettant d'accomplir, par voie électronique, la notification et les démarches nécessaires à la résiliation du contrat. Lorsque le consommateur notifie la résiliation du contrat, le professionnel lui confirme la réception de la notification et l'informe, sur un support durable et dans des délais raisonnables, de la date à laquelle le contrat prend fin et des effets de la résiliation. Un décret fixe notamment les modalités techniques de nature à garantir une identification du consommateur et un accès facile, direct et permanent à la fonctionnalité mentionnée au deuxième alinéa, telles que ses modalités de présentation et d'utilisation. Il détermine les informations devant être fournies par le consommateur.",
          "Article L. 215-2 : Les dispositions du présent chapitre, à l'exception de l'article L. 215-1-1, ne sont pas applicables aux exploitants des services d'eau potable et d'assainissement.",
          "Article L. 215-3 : Les dispositions du présent chapitre sont également applicables aux contrats conclus entre des professionnels et des non-professionnels.",
          "Article L. 241-3 : Lorsque le professionnel n'a pas procédé au remboursement dans les conditions prévues à l'article L. 215-1, les sommes dues sont productives d'intérêts au taux légal.",
        ],
      ),
    ],
  },
  {
    id: "retractation",
    title: "8. Droit de rétractation du consommateur",
    blocks: [
      paragraph(
        "Le consommateur dispose de quatorze jours à compter de la conclusion du contrat pour se rétracter sans motif. Il peut utiliser la fonctionnalité visible « Renoncer au contrat ici » à https://blame.so/fr/retractation, écrire à withdrawal@blame.so ou à l'adresse postale de Blame, ou utiliser le formulaire type en annexe.",
      ),
      paragraph(
        "La déclaration en ligne recueille le nom, le prénom, les indications permettant d'identifier le contrat et le moyen électronique choisi pour l'accusé. Après un récapitulatif, elle est envoyée par le bouton « Confirmer la rétractation ». Un accusé mentionnant le contenu, la date et l'heure est immédiatement remis sur support durable.",
      ),
      paragraph(
        "Si le consommateur demande le commencement du Service avant la fin du délai puis se rétracte valablement, Blame ne retient actuellement aucun montant proportionnel pour la partie exécutée. La perte du droit pour un contenu numérique sans support matériel suppose le consentement préalable exprès et la reconnaissance séparée exigés par la loi ; la seule acceptation des présentes conditions ne suffit pas.",
      ),
      paragraph(
        "Blame rembourse les sommes dues sans retard injustifié et au plus tard quatorze jours après réception de la rétractation, par le moyen de paiement initial sauf accord exprès différent, sans frais. Les exceptions légales impératives demeurent applicables.",
      ),
    ],
  },
  {
    id: "licence",
    title: "9. Licence d'utilisation",
    blocks: [
      paragraph(
        "Sous réserve du contrat et du paiement, Blame accorde pendant la période autorisée une licence personnelle, limitée, non exclusive, non transférable et non sous-licenciable pour installer et utiliser l'Application en code objet pour des activités de développement que le Client est autorisé à réaliser.",
      ),
      list(
        "Le Client ne doit pas copier ou distribuer l'Application au-delà de ce que la loi ou le contrat permet.",
        "Il ne doit pas contourner une licence, une mesure de sécurité, une limite d'appareil ou un contrôle d'accès.",
        "Il ne doit pas désassembler, décompiler ou rechercher le code source, sauf dans la stricte mesure où une disposition impérative l'autorise malgré cette restriction et après avoir demandé les informations nécessaires lorsque la loi l'exige.",
        "Il ne doit pas louer, revendre, sous-licencier ou exploiter le Service pour fournir un produit concurrent non autorisé.",
      ),
    ],
  },
  {
    id: "actions-agents",
    title: "10. Environnements locaux et actions des agents",
    blocks: [
      paragraph(
        "Les agents peuvent lire et modifier des fichiers, exécuter des commandes, installer des dépendances, utiliser le réseau, créer des branches ou worktrees et contacter des services configurés. Le Client doit examiner les demandes d'autorisation, sauvegarder les éléments importants et vérifier les résultats avant intégration ou déploiement.",
      ),
      paragraph(
        "Le Client n'autorise que les actions qu'il initie, approuve ou configure et doit détenir les droits nécessaires sur chaque appareil, dépôt, compte, système et donnée concernés. Une confirmation réduit les risques mais ne garantit pas l'absence d'erreur ou d'effet inattendu.",
      ),
    ],
  },
  {
    id: "tiers",
    title: "11. Fournisseurs d'IA, MCP et services tiers",
    blocks: [
      paragraph(
        "Le Client choisit et configure ses Fournisseurs d'IA, passerelles, serveurs MCP, dépôts et autres services tiers. Leurs contrats, politiques, coûts, quotas, localisations, rétentions et pratiques d'entraînement s'appliquent indépendamment. Blame ne garantit pas un service tiers choisi par le Client.",
      ),
      paragraph(
        "Lorsque le Client demande une transmission, il autorise Blame à transmettre les données sélectionnées et nécessaires au destinataire configuré. Le Client doit retirer les secrets et données non nécessaires et vérifier que le destinataire convient à son usage. Blame reste responsable de ses propres obligations non excluables.",
      ),
    ],
  },
  {
    id: "contenu-client",
    title: "12. Contenu Client, confidentialité et résultats",
    blocks: [
      paragraph(
        "Le Client conserve ses droits sur le Contenu Client. Il accorde à Blame une licence non exclusive, mondiale et limitée pour héberger, copier, transmettre et traiter ce contenu uniquement afin de fournir, maintenir, sécuriser, dépanner et supporter le Service, respecter la loi et appliquer le contrat.",
      ),
      paragraph(
        "Blame n'utilise pas le Contenu Client ou les résultats pour entraîner ou affiner un modèle d'IA à la date d'entrée en vigueur. Une utilisation future ne pourra résulter d'une simple modification des conditions : elle supposera une information préalable claire et un consentement facultatif distinct et révocable.",
      ),
      paragraph(
        "Le Client est responsable des droits, autorisations, bases légales et instructions nécessaires. Les résultats peuvent être inexacts, incomplets, non sécurisés ou similaires à ceux reçus par d'autres utilisateurs. Le Client doit les examiner, tester et adapter avant de les utiliser, publier ou déployer.",
      ),
    ],
  },
  {
    id: "utilisation-acceptee",
    title: "13. Utilisations interdites",
    blocks: [
      list(
        "Enfreindre une loi, un droit de propriété intellectuelle, une obligation de confidentialité, de protection des données ou de contrôle des exportations.",
        "Accéder, tester, perturber, endommager, surcharger ou contrôler sans autorisation un appareil, compte, dépôt, modèle, réseau ou système.",
        "Introduire un logiciel malveillant, exfiltrer des données, contourner un contrôle de sécurité ou faciliter une fraude, une violence ou une surveillance illégale.",
        "Traiter des données de santé, catégories particulières, identifiants gouvernementaux, données financières sensibles ou données d'enfants lorsque la documentation et les garanties applicables ne l'autorisent pas expressément.",
        "Utiliser le Service pour prendre une décision à haut risque sans contrôle humain, validation et garanties appropriés.",
        "Usurper une identité, partager un compte, revendre un accès ou utiliser le Service pour développer un produit concurrent au moyen d'une extraction systématique non autorisée.",
      ),
      paragraph(
        "Blame peut prendre une mesure proportionnée pour prévenir ou faire cesser un risque, en tenant compte de sa gravité et des droits du Client. Les activités de sécurité autorisées et conduites de bonne foi restent possibles dans le cadre convenu.",
      ),
    ],
  },
  {
    id: "propriete-blame",
    title: "14. Propriété intellectuelle de Blame et retours",
    blocks: [
      paragraph(
        "Blame et ses concédants conservent tous les droits sur l'Application, le site, les interfaces, la documentation, les marques, les méthodes et améliorations, à l'exclusion du Contenu Client. Aucun droit implicite n'est accordé.",
      ),
      paragraph(
        "Un retour volontaire non confidentiel reste la propriété de son auteur, qui accorde à Blame une licence mondiale, non exclusive, transférable, sous-licenciable et gratuite pendant la durée légale des droits pour l'évaluer, le reproduire, l'adapter et l'intégrer aux produits et services. Les droits moraux inaliénables ne sont pas cédés.",
      ),
    ],
  },
  {
    id: "donnees-securite",
    title: "15. Données personnelles et sécurité",
    blocks: [
      paragraph(
        "La Politique de confidentialité à https://blame.so/privacy décrit les données, finalités, bases légales, destinataires, transferts, durées, mesures et droits. Lorsque Blame agit comme sous-traitant d'un Client professionnel, le DPA à https://blame.so/legal/dpa s'applique.",
      ),
      paragraph(
        "L'application Desktop n'envoie aucune télémétrie à Blame. Les services cloud de Blame enregistrent des événements, métriques et traces techniques minimisés sur leur propre fonctionnement afin de l'exploiter, le sécuriser, le diagnostiquer et l'améliorer. Les journaux locaux ne sont pas automatiquement transmis. En cas d'échec, l'application peut préremplir un ticket sur le dépôt GitHub public de Blame : rien n'est transmis tant que l'utilisateur ne le publie pas lui-même sur GitHub.",
      ),
      paragraph(
        "Aucune mesure de sécurité n'élimine tout risque. Blame met en œuvre des mesures proportionnées, chiffre les secrets applicables et limite les accès. Le Client doit protéger son environnement et ne pas transmettre de secret dans un canal non prévu.",
      ),
    ],
  },
  {
    id: "disponibilite-support",
    title: "16. Disponibilité, support et sauvegardes",
    blocks: [
      paragraph(
        "Blame vise à maintenir le Service et corriger les défauts matériels, mais des maintenances, incidents de sécurité, pannes internet, services tiers ou conditions locales peuvent l'interrompre. Aucun niveau de service garanti ne s'applique sauf engagement écrit ou droit impératif.",
      ),
      paragraph(
        "Les demandes peuvent être envoyées à tout moment à support@blame.so et sont normalement examinées de 9 h à 18 h, heure de Paris, du lundi au vendredi hors jours fériés français. Ces horaires ne garantissent pas un délai de réponse ou de résolution.",
      ),
      paragraph(
        "Le Client conserve les sauvegardes de ses fichiers locaux et dépôts. Les sauvegardes cloud de Blame servent à la continuité et ne constituent pas un service d'archivage individuel. Elles sont soumises à une rotation maximale de quatre-vingt-dix jours.",
      ),
    ],
  },
  {
    id: "mises-a-jour",
    title: "17. Mises à jour et modifications du Service",
    blocks: [
      paragraph(
        "Blame fournit pendant l'Abonnement les mises à jour nécessaires au maintien de la conformité et informe le Client de leur disponibilité et des conséquences d'une non-installation. Le Client doit installer les mises à jour nécessaires dans un délai raisonnable lorsqu'il en a été correctement informé.",
      ),
      paragraph(
        "Une modification au-delà de ce qui est nécessaire à la conformité doit reposer sur un motif valable prévu au contrat, notamment sécurité, loi, abus, performance, interopérabilité ou évolution fonctionnelle, être sans coût supplémentaire, être clairement expliquée et, si elle affecte négativement l'accès ou l'utilisation de manière non mineure, donner lieu au préavis et au droit de résolution prévus par la loi.",
      ),
    ],
  },
  {
    id: "suspension-fin",
    title: "18. Suspension, fin du contrat et données",
    blocks: [
      paragraph(
        "Blame peut suspendre une fonction ou un compte dans la mesure raisonnablement nécessaire pour répondre à un risque de sécurité, une fraude, un impayé, une utilisation interdite ou une obligation légale. Sauf urgence ou interdiction légale, Blame informe le Client du motif et lui laisse une possibilité raisonnable de remédier.",
      ),
      paragraph(
        "Une violation grave ou non corrigée après mise en demeure peut entraîner la résolution selon la loi. Blame peut cesser le Service sur préavis raisonnable et rembourse alors au prorata la période payée devenue indisponible, sauf remplacement équivalent accepté ou cause imputable au Client.",
      ),
      paragraph(
        "Le Client peut exporter et fermer son compte via https://blame.so/account/privacy. La fermeture vérifiée désactive l'accès puis supprime les données actives cloud dans un délai maximal de trente jours ; les sauvegardes expirent dans leur rotation de quatre-vingt-dix jours, sous réserve des preuves contractuelles, comptables, légales et contentieuses à conserver. Les fichiers locaux restent sous le contrôle du Client.",
      ),
    ],
  },
  {
    id: "garanties-legales",
    title: "19. Garanties légales du consommateur",
    blocks: [
      paragraph(
        "Le consommateur bénéficie de la garantie légale de conformité applicable aux contenus et services numériques et de la garantie des vices cachés. Il peut écrire à support@blame.so en décrivant le défaut et le remède demandé. Aucun droit légal n'est subordonné à l'achat d'une garantie commerciale.",
      ),
      notice(
        "Encadré légal — fourniture continue mensuelle ou annuelle",
        [
          "Pour l'Abonnement mensuel, la période contractuelle X ci-dessous est d'un mois. Pour l'Abonnement annuel, elle est d'un an. Elle recommence à chaque reconduction valable.",
          "Le consommateur a droit à la mise en œuvre de la garantie légale de conformité en cas d'apparition d'un défaut de conformité durant la période contractuelle d'un mois ou d'un an applicable à compter de la fourniture du contenu numérique ou du service numérique. Durant ce délai, le consommateur n'est tenu d'établir que l'existence du défaut de conformité et non la date d'apparition de celui-ci.",
          "La garantie légale de conformité emporte obligation de fournir toutes les mises à jour nécessaires au maintien de la conformité du contenu numérique ou du service numérique durant la période contractuelle d'un mois ou d'un an applicable.",
          "La garantie légale de conformité donne au consommateur droit à la mise en conformité du contenu numérique ou du service numérique sans retard injustifié suivant sa demande, sans frais et sans inconvénient majeur pour lui.",
          "Le consommateur peut obtenir une réduction du prix en conservant le contenu numérique ou le service numérique, ou il peut mettre fin au contrat en se faisant rembourser intégralement contre renoncement au contenu numérique ou au service numérique, dans les cas énumérés ci-dessous.",
        ],
        [
          "Le professionnel refuse de mettre le contenu numérique ou le service numérique en conformité.",
          "La mise en conformité est retardée de manière injustifiée.",
          "La mise en conformité ne peut intervenir sans frais imposés au consommateur.",
          "La mise en conformité occasionne un inconvénient majeur au consommateur.",
          "La non-conformité persiste malgré une tentative de mise en conformité restée infructueuse.",
        ],
      ),
      notice("Suite de l'encadré légal", [
        "Le consommateur a également droit à une réduction du prix ou à la résolution du contrat lorsque le défaut de conformité est si grave qu'il justifie que la réduction du prix ou la résolution du contrat soit immédiate. Le consommateur n'est alors pas tenu de demander la mise en conformité du contenu numérique ou du service numérique au préalable.",
        "Dans les cas où le défaut de conformité est mineur, le consommateur n'a droit à l'annulation du contrat que si le contrat ne prévoit pas le paiement d'un prix.",
        "Toute période d'indisponibilité du contenu numérique ou du service numérique en vue de sa remise en conformité suspend la garantie qui restait à courir jusqu'à la fourniture du contenu numérique ou du service numérique de nouveau conforme.",
        "Ces droits résultent de l'application des articles L. 224-25-1 à L. 224-25-31 du code de la consommation.",
        "Le professionnel qui fait obstacle de mauvaise foi à la mise en œuvre de la garantie légale de conformité encourt une amende civile d'un montant maximal de 300 000 euros, qui peut être porté jusqu'à 10 % du chiffre d'affaires moyen annuel (article L. 242-18-1 du code de la consommation).",
        "Le consommateur bénéficie également de la garantie légale des vices cachés en application des articles 1641 à 1649 du code civil, pendant une durée de deux ans à compter de la découverte du défaut. Cette garantie donne droit à une réduction de prix si le contenu numérique ou le service numérique est conservé, ou à un remboursement intégral contre renonciation au contenu numérique ou au service numérique.",
      ]),
    ],
  },
  {
    id: "responsabilite",
    title: "20. Responsabilité",
    blocks: [
      notice("Consommateurs", [
        "Blame répond de la bonne exécution de ses obligations selon le droit applicable. Aucune clause ne limite la garantie légale, la responsabilité du fait d'un dommage corporel, d'une faute lourde ou dolosive, d'une fraude, d'une violation d'une obligation essentielle ou toute responsabilité que la loi interdit d'exclure. Le consommateur doit prendre les mesures raisonnables qui n'aggravent pas son dommage.",
      ]),
      notice("Clients professionnels", [
        "Dans la mesure permise par la loi, Blame n'est pas responsable des dommages indirects, pertes de profit, chiffre d'affaires, clientèle, économies, données non sauvegardées ou opportunités. La responsabilité totale de Blame liée au Service est limitée aux sommes hors taxes payées par le Client professionnel pendant les douze mois précédant le fait générateur. Ces exclusions ne couvrent pas la fraude, la faute lourde ou dolosive, le dommage corporel, la violation d'une obligation essentielle vidant le contrat de sa substance, ni une responsabilité non limitable.",
      ]),
      paragraph(
        "Blame n'est pas responsable d'une défaillance uniquement imputable à un service tiers librement choisi, à une instruction du Client, à un environnement incompatible clairement signalé ou à une utilisation non autorisée, sans exclure sa responsabilité propre pour l'intégration, l'information ou les obligations impératives.",
      ),
    ],
  },
  {
    id: "modification-conditions",
    title: "21. Modification des conditions",
    blocks: [
      paragraph(
        "Une nouvelle version peut être proposée pour une évolution légale, de sécurité, fonctionnelle ou de clarté. Elle indique sa version et sa date. Elle ne s'applique pas rétroactivement à un fait ou litige antérieur.",
      ),
      paragraph(
        "Pour un contrat consommateur en cours, une modification n'est opposable que dans les conditions autorisées par la loi. Les modifications matérielles sont normalement proposées pour un renouvellement futur après information claire sur support durable et acceptation expresse lorsqu'elle est requise. Le silence ne vaut pas acceptation lorsqu'un acte affirmatif est nécessaire.",
      ),
    ],
  },
  {
    id: "droit-litiges",
    title: "22. Réclamations, médiation, droit applicable et juridiction",
    blocks: [
      paragraph(
        `Toute réclamation est adressée d'abord à support@blame.so ou par courrier à Raphael Charpentier EI, ${publisher.address}, avec les faits et la solution demandée. Les parties tentent de résoudre le différend de bonne foi, sans retarder une mesure urgente ou un délai de prescription.`,
      ),
      notice("Médiation de la consommation", [
        "Après une réclamation écrite préalable restée sans solution, le consommateur peut saisir gratuitement, selon ses règles et son champ de compétence, CM2C — Centre de la Médiation de la Consommation de Conciliateurs de Justice, 49 rue de Ponthieu, 75008 Paris, France, https://www.cm2c.net. La médiation est facultative pour le consommateur et ne supprime pas son droit de saisir un tribunal.",
      ]),
      paragraph(
        "Le contrat est régi par le droit français. Ce choix ne prive pas le consommateur de la protection impérative du pays de sa résidence habituelle. Le consommateur peut saisir toute juridiction compétente selon les règles impératives, notamment celle de son domicile lorsque la loi le permet.",
      ),
      paragraph(
        "Entre Clients professionnels commerçants, les tribunaux compétents de Lyon ont compétence exclusive si la clause a été rendue très apparente lors de l'acceptation. À défaut, les règles ordinaires de compétence s'appliquent.",
      ),
    ],
  },
  {
    id: "dispositions-generales",
    title: "23. Dispositions générales et contacts",
    blocks: [
      paragraph(
        "Un événement de force majeure produit les effets prévus par l'article 1218 du Code civil. La partie concernée informe l'autre rapidement, limite les effets et reprend l'exécution dès que possible. Les paiements déjà dus et les droits impératifs du consommateur ne sont pas supprimés.",
      ),
      paragraph(
        "Si une clause est invalide, elle est appliquée dans la mesure licite ou écartée sans affecter le reste. Une tolérance ne vaut pas renonciation. Le contrat électronique et sa preuve ont la même valeur que le papier dans les limites légales.",
      ),
      list(
        "Support et réclamations : support@blame.so.",
        "Facturation et résiliation : billing@blame.so.",
        "Rétractation : withdrawal@blame.so.",
        "Données personnelles : privacy@blame.so.",
        "Sécurité : security@blame.so.",
        "Questions juridiques : legal@blame.so.",
      ),
    ],
  },
  {
    id: "formulaire-retractation",
    title: "Annexe — Formulaire type de rétractation",
    blocks: [
      paragraph(
        "Veuillez compléter et renvoyer le présent formulaire uniquement si vous souhaitez vous rétracter du contrat. Vous pouvez utiliser toute autre déclaration dénuée d'ambiguïté ou la fonctionnalité https://blame.so/fr/retractation.",
      ),
      notice("Formulaire type", [
        `À l'attention de Raphael Charpentier EI, nom commercial MK Holding, ${publisher.address}, withdrawal@blame.so.`,
        "Je/Nous vous notifie/notifions par la présente ma/notre rétractation du contrat portant sur la fourniture du service numérique suivant : ____________________.",
        "Commandé le / contrat conclu le : ____________________.",
        "Nom du/des consommateur(s) : ____________________.",
        "Adresse du/des consommateur(s) : ____________________.",
        "Adresse électronique associée au compte : ____________________.",
        "Signature du/des consommateur(s), uniquement en cas de notification sur papier : ____________________.",
        "Date : ____________________.",
      ]),
    ],
  },
] satisfies readonly LegalSection[];

export const frenchTermsReadyForPublication = legalDocumentReadyForPublication(
  true,
  {
    frenchTermsEffectiveDate,
    frenchTermsIntroduction,
    frenchTermsSections,
    frenchTermsVersion,
  },
);
