using System;
using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace FortyTwo.Shared.Models.DTO
{
    public class Player
    {
        public Guid TeamId { get; set; }
        public string Id { get; set; }
        public string Name { get; set; }
        public Bid? Bid { get; set; }
        public bool IsActive { get; set; }
        public virtual int DominoCount { get; set; }
    }

    public class LoggedInPlayer : Player
    {
        [JsonConstructor]
        public LoggedInPlayer() { }

        public LoggedInPlayer(Models.Player player)
        {
            TeamId = player.TeamId;
            Id = player.Id;
            Name = player.Name;
        }

        public List<Domino> Dominos { get; set; } = new List<Domino>();
        public override int DominoCount => Dominos?.Count ?? 0;
    }
}
