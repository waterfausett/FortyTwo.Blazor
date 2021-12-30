using System;
using System.Collections.Generic;

namespace FortyTwo.Shared.Models.DTO
{
    public class Match
    {
        public Guid Id { get; set; }
        public List<Models.Player> Players { get; set; }
        public Game CurrentGame { get; set; } = new Game();
        public Dictionary<Guid, List<Game>> Games { get; set; } = new Dictionary<Guid, List<Game>>();
        public Dictionary<Guid, int> Scores { get; set; }
        public Guid? WinningTeamId { get; set; }
        public DateTimeOffset CreatedOn { get; set; }
        public DateTimeOffset UpdatedOn { get; set; }
    }
}
