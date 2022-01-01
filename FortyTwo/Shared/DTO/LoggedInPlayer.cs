using FortyTwo.Shared.Models;
using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace FortyTwo.Shared.DTO
{
    public class LoggedInPlayer
    {
        [JsonConstructor]
        public LoggedInPlayer() { }

        public LoggedInPlayer(Player player)
        {
            Team = player.Team;
            Id = player.Id;
        }

        public Teams Team { get; set; }
        public string Id { get; set; }
        public Bid? Bid { get; set; }
        public bool IsActive { get; set; }
        public List<Domino> Dominos { get; set; } = new List<Domino>();
    }
}
