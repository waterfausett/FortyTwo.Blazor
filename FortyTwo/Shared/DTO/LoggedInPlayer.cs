using FortyTwo.Shared.Models;
using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace FortyTwo.Shared.DTO
{
    public class LoggedInPlayer
    {
        [JsonConstructor]
        public LoggedInPlayer() { }

        public string Id { get; set; }
        public Teams Team { get; set; }
        public Bid? Bid { get; set; }
        public bool IsActive { get; set; }
        public bool Ready { get; set; }
        public List<Domino> Dominos { get; set; } = new List<Domino>();
    }
}
