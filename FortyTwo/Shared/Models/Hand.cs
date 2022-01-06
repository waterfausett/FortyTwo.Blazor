using System.Collections.Generic;

namespace FortyTwo.Shared.Models
{
    public class Hand
    {
        public string PlayerId { get; set; }
        public Teams Team { get; set; }
        public List<Domino> Dominos { get; set; } = new List<Domino>();
        public Bid? Bid { get; set; }
    }
}
