namespace FortyTwo.Entity.Models
{
    public class Match
    {
        public Guid Id { get; set; }
        public DateTimeOffset CreatedOn { get; set; }
        public DateTimeOffset UpdatedOn { get; set; }
        public string CurrentGame { get; set; }
        public string Games { get; set; }
        public int? WinningTeam { get; set; }

        public List<MatchPlayer> Players { get; set; }
    }
}
