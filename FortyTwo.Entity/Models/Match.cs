using FortyTwo.Shared.Models;

namespace FortyTwo.Entity.Models
{
    public class Match
    {
        public Match()
        {
            Id = Guid.NewGuid();
            CreatedOn = UpdatedOn = DateTimeOffset.UtcNow;
            CurrentGame = new Game("Game 1");
            Games = new Dictionary<Teams, List<Game>>();
            Players = new List<MatchPlayer>();
        }

        public Match(Guid id) : this() { Id = id; }

        public Guid Id { get; }
        public Game CurrentGame { get; set; }
        public Dictionary<Teams, List<Game>> Games { get; set; }
        public Dictionary<Teams, int> Scores => Games?.ToDictionary(kv => kv.Key, kv => kv.Value.Sum(g => g.Value ?? 0));
        public Teams? WinningTeam { get; set; }
        public DateTimeOffset CreatedOn { get; set; }
        public DateTimeOffset UpdatedOn { get; set; }

        public List<MatchPlayer> Players { get; set; }
    }


    public static class MatchExtensions
    {
        public static void SelectNextPlayer(this Match match)
        {
            // TODO: should no-op or blow up here?

            if (string.IsNullOrWhiteSpace(match.CurrentGame?.CurrentPlayerId)) return;

            var nextPlayerPosition = match.Players.First(x => x.PlayerId == match.CurrentGame.CurrentPlayerId).Position.NextPosition();

            match.CurrentGame.CurrentPlayerId = match.Players.First(x => x.Position == nextPlayerPosition).PlayerId;
        }
    }
}
