﻿using System;

namespace FortyTwo.Shared.Models
{
    public class Player : IEquatable<Player>
    {
        public int TeamId { get; set; }
        public string Id { get; set; }

        public bool Equals(Player other)
        {
            return this.Id == other.Id;
        }
    }
}
