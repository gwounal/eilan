# Eilañ – documentation détaillée

Copie de médias vers une ou plusieurs destinations, avec vérification par hash (xxHash64 ou MD5)
et rapport PDF (nom, poids, copie validée, date).

## Lancer
    npm install
    npm start

## Générer un exécutable
    npm run dist      # .exe (Windows), .dmg (macOS), .AppImage (Linux), à lancer sur chaque OS

## Fonctionnement
- Les fichiers sont lus une seule fois puis écrits en parallèle sur toutes les destinations.
- Robustesse : chaque fichier est écrit sous un nom temporaire (`.eilan-part`) et ne prend son nom définitif qu'une fois contrôlé (taille, ou empreinte en mode vérification) ; un fichier existant n'est remplacé qu'à ce moment, et une coupure ou une annulation ne laisse jamais de fichier tronqué sous son vrai nom. Un fichier dont l'empreinte diffère reste en `.eilan-part` et est signalé en échec.
- Les destinations sont indépendantes : une erreur d'écriture (disque plein, retiré…) ne marque en échec que cette destination ; les autres continuent. Une destination lente n'attend pas les autres : les écritures sont découplées par une file de 6 blocs de 4 Mo (au-delà, la lecture de la source attend). Pool de threads disque porté à 16 (`UV_THREADPOOL_SIZE`).
- Mode vérification : hash calculé à la lecture de la source ; la copie de tous les fichiers (écrits sur toutes les destinations en parallèle) se termine d'abord, puis chaque destination est relue et comparée, toutes les destinations en parallèle
  (après fsync).
- Le dossier source est recréé dans chaque destination, et le PDF est écrit à la racine de chacune.

## Préréglages
Un préréglage est une « recette » de destination et de copie. Tous ses réglages (destinations, arborescence, numérotation des
cartes, vérification, option médias) se modifient dans sa propre fenêtre : crayon de la liste, ou « + Nouveau » (prérempli avec
les réglages actuels). L'arborescence s'affiche sous chaque destination ; le crayon d'une destination ouvre son chemin complet avec les variables (`/Volumes/RAID/{date}/{appareil}/{carte}`) : ce qui précède le premier niveau contenant une variable est la destination, le reste est l'arborescence (commune à toutes les destinations, enregistrée avec le préréglage). Sans préréglage : une copie sans préréglage utilise `{source}`. L'icône disquette « Enregistrer », placée à côté de la pastille du préréglage, n'apparaît que s'il y a quelque chose à enregistrer. Elle met à jour destinations, vérification
et option médias du préréglage actif quand il est marqué « modifié » ; sinon elle ouvre l'éditeur pour enregistrer les réglages
actuels sous un nouveau préréglage. Le bloc « Tournage » de la zone Destination (jour, prochaine carte) avance avec le préréglage sans
le marquer « modifié ». Un clic sur le nom du préréglage actif (zone Destination) ouvre la liste des préréglages, le préréglage actuel y est mis en évidence ; en choisir un autre l'applique (confirmation si le préréglage actif a des modifications non enregistrées). « Tout retirer » dans Destination vide les destinations et désactive le préréglage actif (copie libre).

Un préréglage enregistre : les destinations, l'arborescence (ex. `{date}/{appareil}/{carte}`), le type de copie,
le hash et l'option « vidéos et son uniquement » (extensions vidéo et audio : wav, bwf, aiff, mp3, flac, m4a…). Stockage : `presets.json` dans le dossier de données
de l'application (Linux : `~/.config/Eilan/`, Windows : `%APPDATA%\Eilan\`,
macOS : `~/Library/Application Support/Eilan/`).

## Clés et cartes
La colonne Source liste uniquement les clés USB et cartes mémoire (les disques durs et SSD externes sont exclus),
actualisée toutes les 4 s.
- Windows : lecteurs « amovibles » et disques SD/MMC (PowerShell).
- macOS : volumes marqués « Removable » ou « Secure Digital » par diskutil.
- Linux : disques non rotatifs marqués amovibles (RM) par lsblk, montés.
Un disque dur ou SSD externe reste utilisable via « Choisir le dossier source ».

## Interface
Trois colonnes. Gauche : médias connectés (cartes/clés) et préréglages. Un préréglage se glisse
vers la zone Destination pour être utilisé (un simple clic ne change rien) ; le crayon l'édite dans une fenêtre modale (rien n'est appliqué avant « Enregistrer »).
Les cases à cocher de la liste servent à choisir les préréglages à supprimer (bouton Supprimer).
Centre : Source (nom de la copie, icône « ajouter un dossier source », zone de dépôt, sources), Destination (préréglage déposé et/ou dossiers ajoutés
à la main avec l'icône, vérification Sans / xxHash64 / MD5 et option « vidéos et son uniquement » : tous les réglages de la recette sont réunis là),
« Ajouter à la file » se trouve en bas de la zone Destination, sous la vérification.
Droite : copies à venir et terminées, avec Vider les terminées, Tout annuler, Lancer la copie.
Le nom de la copie (par défaut : le nom de la carte ou du dossier) remplace {source} dans l'arborescence et nomme le rapport PDF ; avec plusieurs sources il
devient `nom_nomDeLaSource`. L'historique est conservé dans `history.json`, à côté de `presets.json`.

## Espace libre, pause
- Toutes les cartes vont vers les destinations du préréglage actif (ou de la zone Destination) : pas de réglage par carte.
- Chaque destination affiche son espace libre ; l'ajout à la file est refusé si la place manque.
- « Déjà copiée » : d'après l'historique (même chemin, mêmes nombre de fichiers et poids). Indicatif : les destinations ne sont pas revérifiées.
- Pause / Reprendre sur la copie en cours ; la durée de pause est retirée du débit et du rapport.

## Arborescence date / appareil / carte
Variables : `{date}`, `{appareil}`, `{carte}`, `{source}`, `{heure}`. Le bouton « Date / Appareil / Carte » remplit le modèle
de tournage. Chaque source déposée a deux champs : Appareil (ex. CAM-A, SON, DRONE ; les valeurs déjà saisies sont
proposées) et Carte (par défaut le nom du support, ex. A001). Résultat : `2026-10-10/CAM-A/A001/…`.
Un champ Appareil vide fait disparaître ce niveau.

## Numérotation automatique des cartes
Dans la fenêtre du préréglage, « Numéroter automatiquement {carte} » définit un préfixe, un nombre de chiffres et le
prochain numéro (A001, A002…). Le compteur est enregistré dans le préréglage et avance à chaque carte ajoutée à la file.
Le prochain numéro est visible, modifiable et réinitialisable (« Réinitialiser » = retour à 1) dans le bloc « Tournage » de la zone Destination.
Un nom saisi à la main dans le champ Carte d'une source prime sur la numérotation.

## Ordre des niveaux
L'arborescence s'affiche en pastilles (Date, Appareil, Carte…). Glissez-les pour changer l'ordre ; les boutons
« + Date », « + Appareil »… se cliquent ou se glissent à l'endroit voulu ; « × » retire un niveau. Pour du texte libre (ex. `Rushes`), tapez directement dans la zone des niveaux : Entrée ou `/` crée la pastille,
Retour arrière retire la dernière, double-clic modifie une pastille de texte.

## Nom, icône et À propos
**Eilañ** (« copier » en breton). Fichiers d'installation et dossier de données : `Eilan` (sans le « ñ », plus sûr dans
les noms de fichiers). L'icône est dans `build/icon.png` (utilisée par electron-builder), les sources dans `assets/`.
Le bouton « i » en haut à gauche, ou le menu de l'application (« À propos d'Eilañ »), ouvre l'unique fenêtre À propos
(version, bouton « Ouvrir le dossier de données », dont le chemin s'affiche en infobulle). Si une version précédente (dossiers `CopyCheck` ou `MediaCopy`) existe, ses préréglages et son historique sont
repris automatiquement.

## Icône dans le Dock (macOS)
En développement (`npm start`), le Dock affiche l'icône d'Eilañ grâce à `app.dock.setIcon` ; le menu de la barre du haut
continue de dire « Electron » tant que l'application n'est pas empaquetée (`npm run dist`). Dans la version installée,
le nom et l'icône viennent du paquet.

## Réglages (engrenage en haut à droite)
- **Langue**, **Thème** et **Format du rapport** se choisissent dans des listes déroulantes.
- **Thème** : Suivre le système (par défaut), Clair ou Foncé. Le réglage s'applique aussi aux boîtes de dialogue du système.
- **Format du rapport** : PDF (par défaut), Texte ou Markdown. Le rapport est écrit dans chaque destination.
- **Langue** : Français, English, Brezhoneg. Le changement est immédiat (interface, menus, messages, rapport).
  Au premier lancement, la langue du système est reprise (français, breton, sinon anglais).
  Les traductions sont dans `src/i18n.js` (la clé est le texte français). **Le breton est une première version à faire
  relire par un locuteur.**
- **Dossier des préréglages** : par défaut dans le dossier de données de l'application. Si vous en choisissez un autre
  (par exemple un dossier partagé), Eilañ y utilise le fichier `presets.json` existant, ou y copie vos préréglages actuels.
  « Par défaut » revient au dossier de l'application ; l'ancien fichier n'est jamais supprimé.
Les réglages sont dans `settings.json` (dossier de données).

## Niveaux mixtes (texte + variables)
Double-clic sur n'importe quel niveau de l'arborescence pour le modifier sur place. On peut y mêler texte et variables :
`J1_{AAAA}_{MM}_{JJ}` donne un dossier `J1_2026_10_10`. Variables : `{date}` (AAAA-MM-JJ), `{AAAA}`, `{MM}`, `{JJ}`,
`{heure}`, `{appareil}`, `{carte}`, `{source}`. Pendant la modification, les boutons « + AAAA », « + MM »… insèrent la
variable au curseur. Un « / » crée toujours un nouveau niveau. Entrée valide, Échap annule, un champ vidé supprime le niveau.

### Jour de tournage `{jour}`

La variable `{jour}` donne le numéro du jour de tournage (`J{jour}_{AAAA}_{MM}_{JJ}` → `J3_2026_10_10`). Le compteur « Jour » apparaît dans le même bloc « Tournage » dès que la structure l'utilise : boutons − / +, saisie directe, valeur enregistrée dans le préréglage. Il ne s'incrémente pas tout seul, car plusieurs cartes d'une même journée partagent le même jour. Un `/` crée toujours un niveau de dossier.

### Tailles des colonnes et des blocs

Chaque colonne est indépendante. Les bordures verticales entre colonnes règlent leur largeur ; dans chaque colonne, les bordures horizontales règlent la hauteur des blocs (Médias connectés / Préréglages à gauche ; Source / Destination au centre). Un double-clic sur une bordure la remet à sa taille par défaut. Les tailles sont mémorisées. En fenêtre étroite (< 1060 px), la mise en page passe sur deux colonnes fixes.

### Vignettes dans le rapport

Pour chaque fichier vidéo, le rapport PDF affiche une vignette (une image représentative, extraite avec ffmpeg) ; en Markdown, les images sont écrites dans un dossier `…_vignettes` à côté du rapport. Le texte brut n'en contient pas. Elles se désactivent dans les Réglages. ffmpeg vient du paquet `ffmpeg-static` (installé par `npm install`) ou, à défaut, de l'ffmpeg du système. Sans ffmpeg, le rapport est écrit sans vignettes. Les formats RAW non lisibles par ffmpeg (R3D, BRAW) n'ont pas de vignette ; les fichiers son non plus.

### Format et fréquence dans le rapport

Pour chaque média, le rapport indique le **format** (codec et résolution : « ProRes 422 HQ · 3840×2160 », « PCM 24 bits »…) et la **fréquence** (images par seconde pour une vidéo, kHz pour un son). Ces informations viennent d'ffmpeg ; sans ffmpeg, ou pour un format qu'il ne lit pas (R3D, BRAW, ARRIRAW), les deux colonnes restent vides.
