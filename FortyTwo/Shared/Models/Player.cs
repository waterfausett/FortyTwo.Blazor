using System;
using System.Collections.Generic;
using System.Linq;

namespace FortyTwo.Shared.Models
{
    public class Player
    {
        public Guid TeamId { get; set; }
        public string Id { get; set; }
        public string Name { get; set; }
        public int? Bid { get; set; }
        public bool IsActive { get; set; }
        public List<Domino> Dominos { get; set; } = new List<Domino>();
        public List<Trick> Tricks { get; set; } = new List<Trick>();
        public int Points => Tricks.Sum(x => x.Value);
    }
}
