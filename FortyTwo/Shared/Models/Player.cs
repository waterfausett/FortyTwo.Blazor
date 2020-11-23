using System;
using System.Collections.Generic;

namespace FortyTwo.Shared.Models
{
    public class Player : IEquatable<Player>
    {
        public Guid TeamId { get; set; }
        public string Id { get; set; }
        public string Name { get; set; }
        public int? Bid { get; set; }
        public bool IsActive { get; set; }
        public List<Domino> Dominos { get; set; } = new List<Domino>();

        public bool Equals(Player other)
        {
            return this.Id == other.Id;
        }
    }
}
