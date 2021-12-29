using System;
using System.Linq;
using System.Text.Json.Serialization;

namespace FortyTwo.Shared.Models
{
    public class Trick
    {
        [JsonConstructor]
        public Trick() { }

        public string PlayerId { get; set; }
        public Guid? TeamId { get; set; }
        public Suit? Suit { get; set; }
        public Domino[] Dominos { get; set; } = new Domino[4];
        public int Value => Dominos?.Sum(x => x?.Value) + 1 ?? 0;
    }
}
