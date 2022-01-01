using System;

namespace FortyTwo.Shared.Models
{
    public class Player : IEquatable<Player>
    {
        public Teams Team { get; set; }
        public string Id { get; set; }
        public int Position { get; set; }

        public bool Equals(Player other)
        {
            return this.Id == other.Id;
        }
    }
}
