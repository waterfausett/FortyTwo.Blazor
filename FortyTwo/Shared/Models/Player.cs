using System;

namespace FortyTwo.Shared.Models
{
    public class Player : IEquatable<Player>
    {
        public string Id { get; set; }
        public Positions Position { get; set; }

        public bool Equals(Player other)
        {
            return this.Id == other.Id;
        }
    }
}
