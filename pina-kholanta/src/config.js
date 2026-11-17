const minutes = (name, fallback) => {
  const value = Number(process.env[name]);
  return (Number.isFinite(value) && value > 0 ? value : fallback) * 60 * 1000;
};

module.exports = {
  // Nom de la commande principale : /pkl profil, /pkl classement…
  COMMAND_NAME: 'pkl',

  // Temps cumulé minimum en voc pour pouvoir voter et être noté
  MIN_PRESENCE_MS: minutes('MIN_PRESENCE_MINUTES', 60),
  // Le vocal doit rester vide ce temps-là pour que la session se termine
  EMPTY_GRACE_MS: minutes('EMPTY_GRACE_MINUTES', 5),
  // Durée du conseil (vote) après la fin de session
  VOTE_DURATION_MS: minutes('VOTE_DURATION_MINUTES', 15),

  // En dessous de ce nombre de joueurs éligibles, pas de conseil
  MIN_ELIGIBLE_PLAYERS: 3,

  // Catégories créées au premier lancement (modifiables avec /pkl categorie)
  DEFAULT_CATEGORIES: ['Niveau', 'Humour', 'Humilité', 'Gentillesse'],

  // Pause entre chaque révélation, pour le suspense
  REVEAL_DELAY_MS: 3000,
};
