﻿using FortyTwo.Shared.Models.DTO;
using System.Collections.Generic;

namespace FortyTwo.Client.Store
{
    public interface IClientStore
    {
        public List<Match> Matches { get; set; }
    }
}