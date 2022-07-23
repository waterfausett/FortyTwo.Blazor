using FortyTwo.Shared.Models;

namespace FortyTwo.Entity.Models
{
    public class MatchPlayer
    {
        public int Id { get; set; }
        public Guid MatchId { get; set; }
        public string PlayerId { get; set; }
        public Positions Position { get; set; }
        public bool Ready { get; set; }

        public Match Match { get; set; }
    }

    public static class MatchPlayerExtensions
    {
        public static Teams Team(this MatchPlayer player)
            => (int)player.Position % 2 == 0 ? Teams.TeamA : Teams.TeamB;
    }
}
